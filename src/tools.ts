import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  SpotifyError,
  describeDevice,
  describeTrack,
  getDevices,
  matchDevice,
  currentVolume,
  rememberVolume,
  resolveDevice,
  spotify,
  startPlayback,
  startPlaybackWithShuffle,
  getPlaybackState,
  type Device,
  type PlayResult,
  toSpotifyUri,
  transferPlayback,
} from "./spotify";
import {
  MAX_PLAY_URIS,
  findBlend,
  findPlaylist,
  likedSongsContext,
  listBlends,
  type Playlist,
  likedTrackUris,
  playlistTracksByDateAdded,
} from "./library";

const INSTRUCTIONS = `Controls Spotify playback on the owner's devices (phone, computer, speakers, TV...).
- When you pick a song for the user, call \`play\` to actually start it (with \`query\` or Spotify URIs).
- If the user names a device ("play it on the kitchen speaker", "on my phone"), pass that name as \`device\`; fuzzy names are fine.
- If you're unsure which devices exist, call \`list_devices\`. Devices only appear while Spotify is open on them.
- To stop the music, call \`pause\`.
- "Play my <name> playlist" → \`play_playlist\`; "newest to oldest" / "latest first" → order newest_first.
- "Play my likes" / "liked songs" → \`play_liked_songs\`.
- "Play my blend with <person>" → \`play_blend\` with whatever name the user gave, even if it's rough or misspelled.`;

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
  is_playable?: boolean;
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
  // market=from_token returns the versions of tracks that play in the user's country.
  const result = await spotify<SearchResponse>(env, "GET", "/search", {
    query: { q: query, type, limit, market: "from_token" },
  });
  return (result?.[`${type}s`]?.items ?? []).filter(
    (item): item is SearchItem => item !== null && item.is_playable !== false,
  );
}

const where = (device: { name: string } | undefined) => (device ? ` on ${device.name}` : "");

/** Reports what Spotify is actually playing after a play command, or that nothing started. */
function played(intro: string, result: PlayResult, device: Device | undefined): string {
  if (result.playing) return `${intro}${where(device)}. Now playing ${describeTrack(result.state?.item)}.`;
  return [
    `Spotify accepted the command (${intro.charAt(0).toLowerCase()}${intro.slice(1)}${where(device)}) but nothing has started playing.`,
    "The track may not be available in the user's country, or the device may need Spotify opened. Try a different version of the song (search again), an album or playlist, or another device. Don't claim it's playing.",
  ].join(" ");
}

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
        const state = await getPlaybackState(env);
        if (!state) return "Nothing is playing and no device is active.";
        if (!state.item) return `Nothing is loaded on ${describeDevice(state.device)}.`;
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
          const [match] = await search(env, args.query, args.query_type, 5);
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
        const result = await startPlayback(env, device, body);
        return played(Object.keys(body).length ? `Started ${label}` : "Resumed playback", result, device);
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
          const [match] = await search(env, query, "track", 5);
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
      description: [
        "Set the playback volume on a device, either to an exact level (`volume_percent`) or relative to now (`change`).",
        'For "turn it up/down" use change (e.g. +15 / -15); "a bit" ≈ 10, "a lot" ≈ 25.',
        "Spotify takes a few seconds to report the new level, so trust this tool's result rather than re-checking.",
      ].join(" "),
      inputSchema: z.object({
        volume_percent: z.number().int().min(0).max(100).optional().describe("Exact level, 0-100."),
        change: z.number().int().min(-100).max(100).optional().describe("Relative change in percentage points, e.g. 15 or -15."),
        device: deviceParam,
      }),
    },
    ({ volume_percent, change, device: wanted }) =>
      run(async () => {
        if (volume_percent === undefined && change === undefined) throw new SpotifyError("Provide `volume_percent` or `change`.");
        const device = await resolveDevice(env, wanted);
        if (device?.supports_volume === false) throw new SpotifyError(`${device.name} doesn't support remote volume control.`);

        const before = device ? currentVolume(device) : null;
        let target = volume_percent;
        if (target === undefined) {
          if (before === null) throw new SpotifyError("Couldn't read the current volume; give an exact `volume_percent` instead.");
          target = Math.min(100, Math.max(0, before + change!));
        }
        await spotify(env, "PUT", "/me/player/volume", { query: { volume_percent: target, device_id: device?.id ?? undefined } });
        rememberVolume(device, target);
        return `Volume set to ${target}%${before !== null && before !== target ? ` (was ${before}%)` : ""}${where(device)}.`;
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
      description:
        "List the user's own and followed playlists, plus their Spotify Blends, with URIs. Use this to answer \"what playlists/blends do I have?\".",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(50).default(50),
        offset: z.number().int().min(0).default(0),
      }),
      annotations: { readOnlyHint: true },
    },
    ({ limit, offset }) =>
      run(async () => {
        const result = await spotify<{
          items: (Playlist | null)[];
          total: number;
        }>(env, "GET", "/me/playlists", { query: { limit, offset } });
        const items = (result?.items ?? []).filter((item) => item !== null);
        const lines = items.map((item) => `- ${item.name}${item.owner?.display_name ? ` (by ${item.owner.display_name})` : ""} — ${item.uri}`);
        if (!lines.length) lines.push("No playlists found.");
        const total = result?.total ?? items.length;
        if (offset + items.length < total) lines.push(`(${total - offset - items.length} more; use offset ${offset + items.length})`);
        if (offset === 0) {
          const blends = await listBlends(env, items).catch(() => []);
          lines.push(
            "",
            blends.length
              ? `Blends (play with play_blend):\n${blends.map((blend) => `- ${blend.name} — ${blend.uri}`).join("\n")}`
              : "Blends: none set up (they go in the BLENDS setting, since Spotify hides Blends from apps).",
          );
        }
        return lines.join("\n");
      }),
  );

  server.registerTool(
    "play_playlist",
    {
      title: "Play a playlist",
      description: [
        "Play one of the user's playlists, optionally ordered by when tracks were added.",
        "`playlist` can be (part of) the playlist's name, a playlist URI, or an open.spotify.com link.",
        `newest_first / oldest_first sort by date added and play up to ${MAX_PLAY_URIS} tracks; Spotify only allows this for playlists the user owns or collaborates on.`,
      ].join(" "),
      inputSchema: z.object({
        playlist: z.string().min(1).describe('Playlist name (fuzzy, e.g. "gym"), URI or link.'),
        order: z
          .enum(["playlist", "newest_first", "oldest_first", "shuffle"])
          .default("playlist")
          .describe("playlist = normal order; newest_first = most recently added first; oldest_first = first added first."),
        device: deviceParam,
      }),
    },
    ({ playlist: wanted, order, device: wantedDevice }) =>
      run(async () => {
        const playlist = await findPlaylist(env, wanted);
        if (order === "playlist" || order === "shuffle") {
          const device = await resolveDevice(env, wantedDevice);
          const result = await startPlaybackWithShuffle(env, device, { context_uri: playlist.uri }, order === "shuffle");
          return played(`Started "${playlist.name}"${order === "shuffle" ? " on shuffle" : ""}`, result, device);
        }

        const tracks = await playlistTracksByDateAdded(env, playlist, order);
        if (!tracks.uris.length) throw new SpotifyError(`"${playlist.name}" has no playable tracks.`);
        const device = await resolveDevice(env, wantedDevice);
        const result = await startPlaybackWithShuffle(env, device, { uris: tracks.uris }, false);
        const label = order === "newest_first" ? "newest to oldest" : "oldest to newest";
        const partial =
          tracks.uris.length < tracks.total
            ? ` (the ${tracks.uris.length} ${order === "newest_first" ? "most recently" : "earliest"} added of ${tracks.total} tracks${tracks.sorted < tracks.total ? `, sorted from ${tracks.sorted} read` : ""})`
            : "";
        return played(`Started "${playlist.name}" ${label}${partial}`, result, device);
      }),
  );

  server.registerTool(
    "play_liked_songs",
    {
      title: "Play Liked Songs",
      description: `Play the user's Liked Songs ("my likes"). newest_first plays the whole library in liked order; oldest_first plays the ${MAX_PLAY_URIS} earliest likes, oldest first.`,
      inputSchema: z.object({
        order: z.enum(["newest_first", "oldest_first", "shuffle"]).default("newest_first"),
        device: deviceParam,
      }),
    },
    ({ order, device: wantedDevice }) =>
      run(async () => {
        if (order !== "oldest_first") {
          const device = await resolveDevice(env, wantedDevice);
          const shuffle = order === "shuffle";
          try {
            const result = await startPlaybackWithShuffle(env, device, { context_uri: await likedSongsContext(env) }, shuffle);
            if (result.playing) return played(`Started your Liked Songs${shuffle ? " on shuffle" : ", newest first"}`, result, device);
          } catch (error) {
            if (!(error instanceof SpotifyError) || error.reason === "NO_ACTIVE_DEVICE") throw error;
          }
          // Spotify wouldn't play the Liked Songs collection directly, so send the tracks instead.
          const liked = await likedTrackUris(env, "newest_first");
          if (!liked.uris.length) throw new SpotifyError("You don't have any Liked Songs yet.");
          const result = await startPlaybackWithShuffle(env, device, { uris: liked.uris }, shuffle);
          return played(`Started your ${liked.uris.length} most recent Liked Songs${shuffle ? " on shuffle" : ""}`, result, device);
        }

        const liked = await likedTrackUris(env, "oldest_first");
        if (!liked.uris.length) throw new SpotifyError("You don't have any Liked Songs yet.");
        const device = await resolveDevice(env, wantedDevice);
        const result = await startPlaybackWithShuffle(env, device, { uris: liked.uris }, false);
        const scope = liked.uris.length < liked.total ? `your ${liked.uris.length} earliest Liked Songs` : "your Liked Songs";
        return played(`Started ${scope}, oldest first`, result, device);
      }),
  );

  server.registerTool(
    "play_blend",
    {
      title: "Play a Blend",
      description:
        'Play the user\'s Spotify Blend with another person ("play my blend with jack"). The name can be rough or misspelled; it is matched fuzzily.',
      inputSchema: z.object({
        person: z.string().min(1).describe("The other person in the Blend, as the user said it."),
        shuffle: z.boolean().default(false),
        device: deviceParam,
      }),
    },
    ({ person, shuffle, device: wantedDevice }) =>
      run(async () => {
        const blend = await findBlend(env, person);
        const device = await resolveDevice(env, wantedDevice);
        const result = await startPlaybackWithShuffle(env, device, { context_uri: blend.uri }, shuffle);
        return played(`Started your ${blend.name}${shuffle ? " on shuffle" : ""}`, result, device);
      }),
  );

  return server;
}
