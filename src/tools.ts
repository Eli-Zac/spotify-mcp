import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  SpotifyError,
  describeDevice,
  describeTrack,
  getDevices,
  matchDevice,
  resolveDevice,
  spotify,
  startPlayback,
  toSpotifyUri,
  transferPlayback,
  type PlaybackState,
} from "./spotify";

const INSTRUCTIONS = `Controls Spotify playback on the owner's devices (phone, computer, speakers, TV...).
- When you pick a song for the user, call \`play\` to actually start it (with \`query\` or Spotify URIs).
- If the user names a device ("play it on the kitchen speaker", "on my phone"), pass that name as \`device\`; fuzzy names are fine.
- If you're unsure which devices exist, call \`list_devices\`. Devices only appear while Spotify is open on them.
- To stop the music, call \`pause\`.`;

const deviceParam = z
  .string()
  .optional()
  .describe(
    'Device to use: its name (or part of it, e.g. "kitchen", "iPhone", "MacBook"), its type ("phone", "computer", "speaker", "tv"), or its ID. Omit to use the device that is currently playing.',
  );

const searchTypes = ["track", "album", "artist", "playlist"] as const;
type SearchType = (typeof searchTypes)[number];

interface SearchItem {
  name: string;
  uri: string;
  artists?: { name: string }[];
  owner?: { display_name?: string };
  album?: { name: string };
  release_date?: string;
}

type SearchResponse = Partial<Record<`${SearchType}s`, { items: (SearchItem | null)[] }>>;

function text(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }] };
}

/** Runs a tool body, turning Spotify errors into tool errors Claude can read and react to. */
async function run(body: () => Promise<string>): Promise<CallToolResult> {
  try {
    return text(await body());
  } catch (error) {
    const message = error instanceof SpotifyError ? error.message : `Unexpected error: ${String(error)}`;
    if (!(error instanceof SpotifyError)) console.error(error);
    return { content: [{ type: "text", text: message }], isError: true };
  }
}

function describeItem(item: SearchItem, type: SearchType): string {
  const detail =
    type === "track"
      ? ` by ${item.artists?.map((artist) => artist.name).join(", ")} (album: ${item.album?.name})`
      : type === "album"
        ? ` by ${item.artists?.map((artist) => artist.name).join(", ")}${item.release_date ? ` (${item.release_date.slice(0, 4)})` : ""}`
        : type === "playlist" && item.owner?.display_name
          ? ` by ${item.owner.display_name}`
          : "";
  return `${item.name}${detail} — ${item.uri}`;
}

async function search(env: Env, query: string, type: SearchType, limit: number): Promise<SearchItem[]> {
  const result = await spotify<SearchResponse>(env, "GET", "/search", { query: { q: query, type, limit } });
  return (result?.[`${type}s`]?.items ?? []).filter((item): item is SearchItem => item !== null);
}

const where = (device: { name: string } | undefined) => (device ? ` on ${device.name}` : "");

export function createServer(env: Env): McpServer {
  const server = new McpServer({ name: "spotify-playback", version: "1.0.0" }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "list_devices",
    {
      title: "List Spotify devices",
      description:
        "List the Spotify Connect devices available right now (only devices with Spotify open appear), showing which one is active.",
      annotations: { readOnlyHint: true },
    },
    () =>
      run(async () => {
        const devices = await getDevices(env);
        if (!devices.length) return "No devices available. Open Spotify on the device you want to use.";
        return devices.map((device) => `- ${describeDevice(device)} [id: ${device.id}]`).join("\n");
      }),
  );

  server.registerTool(
    "get_playback",
    {
      title: "Get current playback",
      description: "Show what is playing, on which device, and the shuffle/repeat/volume state.",
      annotations: { readOnlyHint: true },
    },
    () =>
      run(async () => {
        const state = await spotify<PlaybackState>(env, "GET", "/me/player", {
          query: { additional_types: "episode" },
        });
        if (!state) return "Nothing is playing and no device is active.";
        const progress = state.progress_ms !== null ? Math.round(state.progress_ms / 1000) : null;
        const duration = state.item ? Math.round(state.item.duration_ms / 1000) : null;
        return [
          `${state.is_playing ? "Playing" : "Paused"}: ${describeTrack(state.item)}${state.item ? ` (${state.item.uri})` : ""}`,
          state.item?.album ? `Album: ${state.item.album.name}` : null,
          progress !== null && duration !== null ? `Position: ${progress}s / ${duration}s` : null,
          `Device: ${describeDevice(state.device)}`,
          `Shuffle: ${state.shuffle_state ? "on" : "off"}, repeat: ${state.repeat_state}`,
          state.context ? `Context: ${state.context.type} ${state.context.uri}` : null,
        ]
          .filter(Boolean)
          .join("\n");
      }),
  );

  server.registerTool(
    "search",
    {
      title: "Search Spotify",
      description: "Search Spotify for tracks, albums, artists or playlists and get their URIs (to pass to play).",
      inputSchema: z.object({
        query: z.string().min(1).describe('Search text, e.g. "Mr. Brightside The Killers" or "artist:Daft Punk"'),
        type: z.enum(searchTypes).default("track"),
        limit: z.number().int().min(1).max(10).default(5),
      }),
      annotations: { readOnlyHint: true },
    },
    ({ query, type, limit }) =>
      run(async () => {
        const items = await search(env, query, type, limit);
        if (!items.length) return `No ${type}s found for "${query}".`;
        return items.map((item, index) => `${index + 1}. ${describeItem(item, type)}`).join("\n");
      }),
  );

  server.registerTool(
    "play",
    {
      title: "Play music",
      description: [
        "Start playback on one of the user's devices. Use this whenever you pick a song for the user.",
        "Provide ONE of: `uris` (one or more tracks, played in order), `context_uri` (an album, playlist or artist), or `query` (searches and plays the best match).",
        "With none of them, resumes whatever was playing.",
        "Pass `device` to choose where it plays, e.g. when the user says 'on my phone' or 'on the living room speaker'.",
      ].join(" "),
      inputSchema: z.object({
        uris: z
          .array(z.string())
          .optional()
          .describe("Track or episode URIs (spotify:track:...) or open.spotify.com links, played in order."),
        context_uri: z
          .string()
          .optional()
          .describe("Album, playlist or artist URI or open.spotify.com link to play."),
        query: z
          .string()
          .optional()
          .describe('Search text to find and play, e.g. "Bohemian Rhapsody Queen". Use with query_type for albums/playlists.'),
        query_type: z.enum(searchTypes).default("track").describe("What `query` should find."),
        start_at_uri: z
          .string()
          .optional()
          .describe("With context_uri: the track URI within the album/playlist to start from."),
        position_ms: z.number().int().min(0).optional().describe("Start this many milliseconds into the first track."),
        device: deviceParam,
      }),
    },
    (args) =>
      run(async () => {
        const body: Record<string, unknown> = {};
        let label: string;

        if (args.uris?.length) {
          const uris = args.uris.map(toSpotifyUri);
          body.uris = uris;
          label = uris.length === 1 ? uris[0]! : `${uris.length} tracks`;
        } else if (args.context_uri) {
          label = toSpotifyUri(args.context_uri);
          body.context_uri = label;
        } else if (args.query) {
          const [match] = await search(env, args.query, args.query_type, 1);
          if (!match) throw new SpotifyError(`No ${args.query_type} found for "${args.query}".`);
          if (args.query_type === "track") body.uris = [match.uri];
          else body.context_uri = match.uri;
          label = describeItem(match, args.query_type);
        } else {
          label = "playback";
        }

        if (args.start_at_uri && body.context_uri) body.offset = { uri: toSpotifyUri(args.start_at_uri) };
        if (args.position_ms !== undefined) body.position_ms = args.position_ms;

        const device = await resolveDevice(env, args.device);
        await startPlayback(env, device, body);
        return Object.keys(body).length ? `Now playing ${label}${where(device)}.` : `Resumed playback${where(device)}.`;
      }),
  );

  server.registerTool(
    "pause",
    {
      title: "Pause / stop playback",
      description: "Pause (stop) playback. Optionally target a specific device.",
      inputSchema: z.object({ device: deviceParam }),
    },
    ({ device: wanted }) =>
      run(async () => {
        const device = wanted ? await resolveDevice(env, wanted) : undefined;
        try {
          await spotify(env, "PUT", "/me/player/pause", { query: { device_id: device?.id ?? undefined } });
        } catch (error) {
          // Pausing something that's already paused is not worth reporting as a failure.
          if (error instanceof SpotifyError && error.status === 403 && /restrict/i.test(error.message)) {
            return `Playback is already paused${where(device)}.`;
          }
          throw error;
        }
        return `Paused${where(device)}.`;
      }),
  );

  server.registerTool(
    "skip",
    {
      title: "Skip track",
      description: "Skip to the next track, or go back to the previous one.",
      inputSchema: z.object({
        direction: z.enum(["next", "previous"]).default("next"),
        device: deviceParam,
      }),
    },
    ({ direction, device: wanted }) =>
      run(async () => {
        const device = wanted ? await resolveDevice(env, wanted) : undefined;
        await spotify(env, "POST", `/me/player/${direction}`, { query: { device_id: device?.id ?? undefined } });
        return direction === "next" ? `Skipped to the next track${where(device)}.` : `Went back a track${where(device)}.`;
      }),
  );

  server.registerTool(
    "add_to_queue",
    {
      title: "Add to queue",
      description: "Add a track to the end of the play queue, by URI or by search query.",
      inputSchema: z.object({
        uri: z.string().optional().describe("Track or episode URI or open.spotify.com link."),
        query: z.string().optional().describe("Search text; the best matching track is queued."),
        device: deviceParam,
      }),
    },
    ({ uri, query, device: wanted }) =>
      run(async () => {
        let target: string;
        let label: string;
        if (uri) {
          target = toSpotifyUri(uri);
          label = target;
        } else if (query) {
          const [match] = await search(env, query, "track", 1);
          if (!match) throw new SpotifyError(`No track found for "${query}".`);
          target = match.uri;
          label = describeItem(match, "track");
        } else {
          throw new SpotifyError("Provide either `uri` or `query`.");
        }
        const device = wanted ? await resolveDevice(env, wanted) : undefined;
        await spotify(env, "POST", "/me/player/queue", { query: { uri: target, device_id: device?.id ?? undefined } });
        return `Queued ${label}${where(device)}.`;
      }),
  );

  server.registerTool(
    "transfer_playback",
    {
      title: "Move playback to a device",
      description: "Move the current playback to another device (e.g. 'move the music to the kitchen speaker').",
      inputSchema: z.object({
        device: z.string().describe("Name, type or ID of the device to move playback to."),
        play: z
          .boolean()
          .default(true)
          .describe("Start playing on the new device. false keeps the current play/pause state."),
      }),
    },
    ({ device: wanted, play }) =>
      run(async () => {
        const device = matchDevice(await getDevices(env), wanted);
        await transferPlayback(env, device.id!, play);
        return `Moved playback to ${device.name}.`;
      }),
  );

  server.registerTool(
    "set_volume",
    {
      title: "Set volume",
      description: "Set the playback volume (0-100) on a device.",
      inputSchema: z.object({
        volume_percent: z.number().int().min(0).max(100),
        device: deviceParam,
      }),
    },
    ({ volume_percent, device: wanted }) =>
      run(async () => {
        const device = await resolveDevice(env, wanted);
        if (device?.supports_volume === false) throw new SpotifyError(`${device.name} doesn't support remote volume control.`);
        await spotify(env, "PUT", "/me/player/volume", { query: { volume_percent, device_id: device?.id ?? undefined } });
        return `Volume set to ${volume_percent}%${where(device)}.`;
      }),
  );

  server.registerTool(
    "set_playback_options",
    {
      title: "Set shuffle / repeat",
      description: "Turn shuffle on or off and/or set the repeat mode.",
      inputSchema: z.object({
        shuffle: z.boolean().optional(),
        repeat: z.enum(["off", "track", "context"]).optional().describe("context = repeat the album/playlist."),
        device: deviceParam,
      }),
    },
    ({ shuffle, repeat, device: wanted }) =>
      run(async () => {
        if (shuffle === undefined && repeat === undefined) throw new SpotifyError("Provide `shuffle` and/or `repeat`.");
        const device = wanted ? await resolveDevice(env, wanted) : undefined;
        const device_id = device?.id ?? undefined;
        const changes: string[] = [];
        if (shuffle !== undefined) {
          await spotify(env, "PUT", "/me/player/shuffle", { query: { state: shuffle, device_id } });
          changes.push(`shuffle ${shuffle ? "on" : "off"}`);
        }
        if (repeat !== undefined) {
          await spotify(env, "PUT", "/me/player/repeat", { query: { state: repeat, device_id } });
          changes.push(`repeat ${repeat}`);
        }
        return `Set ${changes.join(" and ")}${where(device)}.`;
      }),
  );

  server.registerTool(
    "list_my_playlists",
    {
      title: "List my playlists",
      description: "List the user's own and followed playlists with their URIs (to pass to play as context_uri).",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(50).default(50),
        offset: z.number().int().min(0).default(0),
      }),
      annotations: { readOnlyHint: true },
    },
    ({ limit, offset }) =>
      run(async () => {
        const result = await spotify<{
          items: ({ name: string; uri: string; owner?: { display_name?: string } } | null)[];
          total: number;
        }>(env, "GET", "/me/playlists", { query: { limit, offset } });
        const items = (result?.items ?? []).filter((item) => item !== null);
        if (!items.length) return "No playlists found.";
        const lines = items.map((item) => `- ${item.name}${item.owner?.display_name ? ` (by ${item.owner.display_name})` : ""} — ${item.uri}`);
        const total = result?.total ?? items.length;
        if (offset + items.length < total) lines.push(`(${total - offset - items.length} more; use offset ${offset + items.length})`);
        return lines.join("\n");
      }),
  );

  return server;
}
