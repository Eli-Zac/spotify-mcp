import { SpotifyError, normalize, spotify, toSpotifyUri } from "./spotify";

/** Spotify doesn't document a cap on `uris` for play; 100 is comfortably accepted. */
export const MAX_PLAY_URIS = 100;
const PAGE_SIZE = 50;
// Workers on the free plan get 50 outbound requests per call, so bound the paging.
const MAX_PLAYLIST_PAGES = 20;
const MAX_PLAYLIST_LIST_PAGES = 4;

export type Order = "newest_first" | "oldest_first";

// --- Current user ----------------------------------------------------------

interface Me {
  id: string;
  display_name: string | null;
}

let cachedMe: Me | null = null;

export async function getMe(env: Env): Promise<Me> {
  cachedMe ??= await spotify<Me>(env, "GET", "/me");
  if (!cachedMe) throw new SpotifyError("Couldn't read your Spotify profile.");
  return cachedMe;
}

// --- Fuzzy matching --------------------------------------------------------

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length]!;
}

/** 1 for an exact match, down to 0 for nothing in common. Tolerates typos and partial names. */
function similarity(wanted: string, candidate: string): number {
  const a = normalize(wanted);
  const b = normalize(candidate);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (b.startsWith(a)) return 0.9;
  if (b.includes(a)) return 0.8;
  if (a.includes(b)) return 0.7;
  return 1 - editDistance(a, b) / Math.max(a.length, b.length);
}

/**
 * Picks the candidate whose best label is closest to `wanted`, or explains
 * what was close (ambiguous) or what exists (no match).
 */
export function fuzzyFind<T>(
  items: T[],
  wanted: string,
  labels: (item: T) => string[],
  describe: (item: T) => string,
  noun: string,
): T {
  const scored = items
    .map((item) => ({ item, score: Math.max(0, ...labels(item).map((label) => similarity(wanted, label))) }))
    .filter((entry) => entry.score >= 0.5)
    .sort((a, b) => b.score - a.score);

  const [best, second] = scored;
  if (best && (best.score === 1 || !second || best.score - second.score >= 0.1)) return best.item;
  if (best) {
    const close = scored.filter((entry) => best.score - entry.score < 0.1).map((entry) => `- ${describe(entry.item)}`);
    throw new SpotifyError(`"${wanted}" could be more than one ${noun}:\n${close.join("\n")}`);
  }
  const known = items.slice(0, 30).map((item) => `- ${describe(item)}`);
  throw new SpotifyError(
    `No ${noun} matches "${wanted}".${known.length ? ` Available:\n${known.join("\n")}` : ""}`,
  );
}

// --- Playlists -------------------------------------------------------------

export interface Playlist {
  id: string;
  name: string;
  uri: string;
  description?: string | null;
  collaborative?: boolean;
  owner?: { id: string; display_name?: string | null };
}

interface Page<T> {
  items: (T | null)[];
  total: number;
  next?: string | null;
}

export async function listMyPlaylists(env: Env): Promise<Playlist[]> {
  const playlists: Playlist[] = [];
  for (let page = 0; page < MAX_PLAYLIST_LIST_PAGES; page++) {
    const result = await spotify<Page<Playlist>>(env, "GET", "/me/playlists", {
      query: { limit: PAGE_SIZE, offset: page * PAGE_SIZE },
    });
    playlists.push(...(result?.items ?? []).filter((item): item is Playlist => item !== null));
    if (!result?.next) break;
  }
  return playlists;
}

const describePlaylist = (playlist: Playlist) =>
  `${playlist.name}${playlist.owner?.display_name ? ` (by ${playlist.owner.display_name})` : ""}`;

/** Accepts a playlist URI, an open.spotify.com link, or (part of) the name of one of your playlists. */
export async function findPlaylist(env: Env, wanted: string): Promise<Playlist> {
  if (/^spotify:|open\.spotify\.com/.test(wanted.trim())) {
    const uri = toSpotifyUri(wanted);
    const [, type, id] = uri.split(":");
    if (type !== "playlist" || !id) throw new SpotifyError(`${wanted} is not a playlist.`);
    const known = (await listMyPlaylists(env)).find((playlist) => playlist.id === id);
    return known ?? { id, uri, name: uri };
  }
  return fuzzyFind(await listMyPlaylists(env), wanted, (playlist) => [playlist.name], describePlaylist, "playlist");
}

interface EntryTrack {
  uri: string;
  name?: string;
  is_local?: boolean;
  artists?: { name: string }[];
  linked_from?: { uri: string };
}

interface PlaylistEntry {
  added_at?: string | null;
  // Renamed from `track` to `item` in Spotify's February 2026 API update.
  item?: EntryTrack | null;
  track?: EntryTrack | null;
}

export interface PlaylistTrack {
  uri: string;
  /** The URI the track was originally saved under, when Spotify swapped in your country's version. */
  originalUri?: string;
  name: string;
  artists: string;
  addedAt: string | null;
}

const MAX_READ_TRACKS = MAX_PLAYLIST_PAGES * PAGE_SIZE;

/**
 * Reads a window of a playlist's tracks in playlist order. Spotify only returns
 * the tracks of playlists you own or collaborate on.
 */
export async function readPlaylistTracks(
  env: Env,
  playlist: Playlist,
  options: { offset?: number; limit?: number } = {},
): Promise<{ tracks: PlaylistTrack[]; total: number }> {
  const offset = Math.max(0, options.offset ?? 0);
  const limit = Math.min(MAX_READ_TRACKS, Math.max(1, options.limit ?? 100));
  const fetchPage = (from: number) =>
    spotify<Page<PlaylistEntry>>(env, "GET", `/playlists/${playlist.id}/items`, {
      query: { limit: PAGE_SIZE, offset: from },
    });

  let first: Page<PlaylistEntry> | null;
  try {
    first = await fetchPage(offset);
  } catch (error) {
    if (error instanceof SpotifyError && (error.status === 403 || error.status === 404)) {
      throw new SpotifyError(
        `Spotify only lets this server read the track list of playlists you own or collaborate on, so it can't read "${playlist.name}" (Blends and other people's playlists are hidden from apps).`,
        error.status,
      );
    }
    throw error;
  }
  const total = first?.total ?? 0;

  const offsets: number[] = [];
  for (let from = offset; from < Math.min(total, offset + limit); from += PAGE_SIZE) offsets.push(from);
  const pages = await Promise.all(offsets.map((from) => (from === offset ? first : fetchPage(from))));

  const tracks = pages
    .flatMap((page) => page?.items ?? [])
    .slice(0, limit)
    .flatMap((entry): PlaylistTrack[] => {
      const track = entry?.item ?? entry?.track;
      if (!track?.uri) return [];
      return [
        {
          uri: track.uri,
          originalUri: track.linked_from?.uri,
          name: track.name ?? track.uri,
          artists: track.artists?.map((artist) => artist.name).join(", ") ?? "",
          addedAt: entry?.added_at ?? null,
        },
      ];
    });
  return { tracks, total };
}

/**
 * Adds tracks to one of your playlists, skipping any already in it (unless told not to).
 * Needs the playlist-modify scopes, and a playlist you own or collaborate on.
 */
export async function addTracksToPlaylist(
  env: Env,
  playlist: Playlist,
  uris: string[],
  options: { skipDuplicates?: boolean } = {},
): Promise<{ added: string[]; skipped: string[] }> {
  let toAdd = [...new Set(uris)];
  let skipped: string[] = [];

  if (options.skipDuplicates ?? true) {
    const { tracks } = await readPlaylistTracks(env, playlist, { limit: MAX_READ_TRACKS });
    const existing = new Set(tracks.flatMap((track) => [track.uri, track.originalUri].filter(Boolean) as string[]));
    skipped = toAdd.filter((uri) => existing.has(uri));
    toAdd = toAdd.filter((uri) => !existing.has(uri));
  }

  if (toAdd.length) {
    try {
      await spotify(env, "POST", `/playlists/${playlist.id}/items`, { body: { uris: toAdd } });
    } catch (error) {
      if (error instanceof SpotifyError && error.status === 403 && error.reason !== "INSUFFICIENT_SCOPE") {
        throw new SpotifyError(
          `Spotify wouldn't let this server change "${playlist.name}". Playlists can only be edited if you own or collaborate on them.`,
          403,
        );
      }
      throw error;
    }
  }
  return { added: toAdd, skipped };
}

export interface OrderedTracks {
  uris: string[];
  total: number;
  /** How many tracks were read and sorted (less than total for very large playlists). */
  sorted: number;
}

/**
 * Reads a playlist's tracks and sorts them by when they were added. Spotify only
 * returns the tracks of playlists you own or collaborate on.
 */
export async function playlistTracksByDateAdded(env: Env, playlist: Playlist, order: Order): Promise<OrderedTracks> {
  const path = `/playlists/${playlist.id}/items`;
  const fetchPage = (offset: number) =>
    spotify<Page<PlaylistEntry>>(env, "GET", path, { query: { limit: PAGE_SIZE, offset } });

  let first: Page<PlaylistEntry> | null;
  try {
    first = await fetchPage(0);
  } catch (error) {
    if (error instanceof SpotifyError && (error.status === 403 || error.status === 404)) {
      throw new SpotifyError(
        `Spotify only lets this server read the track list of playlists you own or collaborate on, so it can't reorder "${playlist.name}". Play it in its normal order or shuffled instead.`,
        error.status,
      );
    }
    throw error;
  }
  const total = first?.total ?? 0;

  // Very large playlists: read the end for newest-first, the start for oldest-first.
  const maxItems = MAX_PLAYLIST_PAGES * PAGE_SIZE;
  const start = total > maxItems && order === "newest_first" ? total - maxItems : 0;
  const end = Math.min(total, start + maxItems);
  const offsets: number[] = [];
  for (let offset = start; offset < end; offset += PAGE_SIZE) offsets.push(offset);

  const pages = await Promise.all(offsets.map((offset) => (offset === 0 ? first : fetchPage(offset))));
  const entries = pages.flatMap((page, pageIndex) =>
    (page?.items ?? []).map((entry, index) => ({
      position: offsets[pageIndex]! + index,
      addedAt: entry?.added_at ? Date.parse(entry.added_at) : 0,
      track: entry?.item ?? entry?.track,
    })),
  );

  const direction = order === "newest_first" ? -1 : 1;
  const playable = entries
    .filter((entry) => entry.track?.uri && !entry.track.is_local && !entry.track.uri.startsWith("spotify:local:"))
    .sort((a, b) => direction * (a.addedAt - b.addedAt || a.position - b.position));

  return { uris: playable.slice(0, MAX_PLAY_URIS).map((entry) => entry.track!.uri), total, sorted: entries.length };
}

// --- Liked Songs -----------------------------------------------------------

export async function likedSongsContext(env: Env): Promise<string> {
  return `spotify:user:${(await getMe(env)).id}:collection`;
}

/** Liked Songs come back newest first; oldest-first reads from the end of the list. */
export async function likedTrackUris(env: Env, order: Order): Promise<{ uris: string[]; total: number }> {
  const fetchPage = (offset: number) =>
    spotify<Page<{ track: { uri: string } | null }>>(env, "GET", "/me/tracks", { query: { limit: PAGE_SIZE, offset } });

  const first = await fetchPage(0);
  const total = first?.total ?? 0;
  const start = order === "newest_first" ? 0 : Math.max(0, total - MAX_PLAY_URIS);
  const offsets: number[] = [];
  for (let offset = start; offset < Math.min(total, start + MAX_PLAY_URIS); offset += PAGE_SIZE) offsets.push(offset);

  const pages = await Promise.all(offsets.map((offset) => (offset === 0 ? first : fetchPage(offset))));
  const uris = pages.flatMap((page) => (page?.items ?? []).map((entry) => entry?.track?.uri)).filter(Boolean) as string[];
  return { uris: order === "newest_first" ? uris : uris.reverse(), total };
}

// --- Blends ----------------------------------------------------------------

export interface Blend {
  /** Every name this Blend answers to (several BLENDS lines can share one link). */
  people: string[];
  uri: string;
  name: string;
}

/**
 * Parses the BLENDS setting: one `name: link` per line (or separated by `;` or `,`),
 * e.g. `Jack: https://open.spotify.com/playlist/37i9dQZF1EJ...`.
 */
export function parseBlendsSetting(value: string | undefined): Blend[] {
  return (value ?? "")
    .split(/[\n;,]+/)
    .map((entry) => entry.trim().match(/^(.+?)\s*[:=]\s*(\S+)$/))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => {
      const person = match[1]!.trim();
      return { people: [person], uri: toSpotifyUri(match[2]!), name: `Blend with ${person}` };
    });
}

/** Blends named like "Eli + Jack" in your playlists, if Spotify lists them for this app. */
function blendsFromPlaylists(playlists: Playlist[], me: Me): Blend[] {
  const myNames = [me.display_name, me.id].filter(Boolean).map((name) => normalize(name!));
  return playlists.flatMap((playlist) => {
    const isBlend = / \+ /.test(playlist.name) || /\bblend\b/i.test(playlist.description ?? "");
    if (!isBlend) return [];
    const others = playlist.name
      .split(/\s+\+\s+/)
      .map((part) => part.trim())
      .filter((part) => part && !myNames.includes(normalize(part)));
    return [{ people: [others.join(" + ") || playlist.name], uri: playlist.uri, name: playlist.name }];
  });
}

/** Merges entries that share a link, so aliases ("Sadie", "Seidey") count as one Blend. */
function mergeByUri(blends: Blend[]): Blend[] {
  const merged = new Map<string, Blend>();
  for (const blend of blends) {
    const existing = merged.get(blend.uri);
    if (!existing) {
      merged.set(blend.uri, { ...blend, people: [...blend.people] });
      continue;
    }
    for (const person of blend.people) if (!existing.people.includes(person)) existing.people.push(person);
    existing.name = `Blend with ${existing.people.join(" / ")}`;
  }
  return [...merged.values()];
}

/** Your Blends from the BLENDS setting plus any Spotify lists among your playlists. */
export async function listBlends(env: Env, playlists?: Playlist[]): Promise<Blend[]> {
  const configured = parseBlendsSetting(env.BLENDS);
  let discovered: Blend[] = [];
  try {
    discovered = blendsFromPlaylists(playlists ?? (await listMyPlaylists(env)), await getMe(env));
  } catch (error) {
    if (!configured.length) throw error;
  }
  return mergeByUri([...configured, ...discovered]);
}

export async function findBlend(env: Env, person: string): Promise<Blend> {
  const blends = await listBlends(env);
  if (!blends.length) {
    throw new SpotifyError(
      'No Blends are set up. Spotify hides Blend playlists from apps, so add them to the BLENDS setting, one "name: link" per line (in the Spotify app: open the Blend → ⋯ → Share → Copy link).',
    );
  }
  return fuzzyFind(blends, person, (blend) => [...blend.people, blend.name], (blend) => blend.name, "Blend");
}
