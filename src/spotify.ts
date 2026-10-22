import { cleanSecret } from "./auth";

const API_BASE = "https://api.spotify.com/v1";
const TOKEN_URL = "https://accounts.spotify.com/api/token";

export const SPOTIFY_SCOPES = [
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-currently-playing",
  "playlist-read-private",
  "playlist-read-collaborative",
  "user-library-read",
];

/** An error whose message is safe and useful to show to Claude as a tool result. */
export class SpotifyError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly reason?: string,
  ) {
    super(message);
  }
}

// --- Tokens ----------------------------------------------------------------

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
}

// Cached per isolate; a cold start just refreshes again.
let cachedToken: { value: string; expiresAt: number } | null = null;

function basicAuth(env: Env): string {
  return `Basic ${btoa(`${cleanSecret(env.SPOTIFY_CLIENT_ID)}:${cleanSecret(env.SPOTIFY_CLIENT_SECRET)}`)}`;
}

async function requestToken(env: Env, params: Record<string, string>): Promise<TokenResponse> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: basicAuth(env),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params),
  });
  const body = (await response.json().catch(() => ({}))) as Partial<TokenResponse> & {
    error?: string;
    error_description?: string;
  };
  if (!response.ok || !body.access_token) {
    const detail = body.error_description ?? body.error ?? `HTTP ${response.status}`;
    if (body.error === "invalid_grant") {
      throw new SpotifyError(
        `Spotify rejected the refresh token (${detail}). Open /setup on the worker to get a new one and update the SPOTIFY_REFRESH_TOKEN secret.`,
        response.status,
      );
    }
    if (body.error === "invalid_client") {
      throw new SpotifyError(
        `Spotify rejected the client credentials (${detail}). Check the SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET secrets.`,
        response.status,
      );
    }
    throw new SpotifyError(`Spotify token request failed: ${detail}`, response.status);
  }
  return body as TokenResponse;
}

export async function exchangeCode(env: Env, code: string, redirectUri: string): Promise<TokenResponse> {
  return requestToken(env, { grant_type: "authorization_code", code, redirect_uri: redirectUri });
}

async function getAccessToken(env: Env): Promise<string> {
  if (cachedToken && cachedToken.expiresAt - 60_000 > Date.now()) return cachedToken.value;
  const refreshToken = cleanSecret(env.SPOTIFY_REFRESH_TOKEN);
  if (!refreshToken) {
    throw new SpotifyError(
      "SPOTIFY_REFRESH_TOKEN is not set. Open /setup/<MCP_AUTH_TOKEN> on the worker to link your Spotify account.",
    );
  }
  const token = await requestToken(env, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  if (token.refresh_token && token.refresh_token !== refreshToken) {
    console.warn(
      "Spotify issued a new refresh token. If requests start failing, re-run /setup and update SPOTIFY_REFRESH_TOKEN.",
    );
  }
  cachedToken = { value: token.access_token, expiresAt: Date.now() + token.expires_in * 1000 };
  return token.access_token;
}

// --- API -------------------------------------------------------------------

type Query = Record<string, string | number | boolean | undefined>;

export async function spotify<T = unknown>(
  env: Env,
  method: string,
  path: string,
  options: { query?: Query; body?: unknown } = {},
): Promise<T | null> {
  const url = new URL(API_BASE + path);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${await getAccessToken(env)}`,
        ...(options.body !== undefined && { "Content-Type": "application/json" }),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });

    if (response.status === 401 && attempt === 0) {
      cachedToken = null;
      continue;
    }
    if (response.ok) {
      // Player commands answer with an empty body or, lately, a bare ID string rather than JSON.
      const text = await response.text();
      if (!text) return null;
      try {
        return JSON.parse(text) as T;
      } catch {
        return null;
      }
    }
    throw await toSpotifyError(response);
  }
}

async function toSpotifyError(response: Response): Promise<SpotifyError> {
  const body = (await response.json().catch(() => null)) as {
    error?: { message?: string; reason?: string } | string;
    reason?: string;
  } | null;
  const error = typeof body?.error === "object" ? body.error : undefined;
  const reason = error?.reason ?? body?.reason;
  const message = error?.message ?? (typeof body?.error === "string" ? body.error : response.statusText);

  if (response.status === 429) {
    const retryAfter = response.headers.get("Retry-After");
    return new SpotifyError(
      reason === "QUOTA_EXCEEDED"
        ? "Spotify API quota exceeded for this developer account."
        : `Spotify rate limit hit${retryAfter ? `; retry in ${retryAfter}s` : ""}.`,
      429,
      reason,
    );
  }
  if (reason === "NO_ACTIVE_DEVICE" || (response.status === 404 && /device/i.test(message))) {
    return new SpotifyError(
      "No active Spotify device. Name a device to play on (see list_devices), or open Spotify on the device you want to use.",
      response.status,
      "NO_ACTIVE_DEVICE",
    );
  }
  if (response.status === 403 && /scope/i.test(message)) {
    return new SpotifyError(
      "Your Spotify link is missing a permission this needs (it was added in an update). Open /setup/<MCP_AUTH_TOKEN> again, then save the new refresh token as SPOTIFY_REFRESH_TOKEN and redeploy.",
      403,
      "INSUFFICIENT_SCOPE",
    );
  }
  if (reason === "PREMIUM_REQUIRED") {
    return new SpotifyError("Spotify Premium is required to control playback.", response.status, reason);
  }
  return new SpotifyError(
    `Spotify API error ${response.status}${reason ? ` (${reason})` : ""}: ${message}`,
    response.status,
    reason,
  );
}

// --- Shapes ----------------------------------------------------------------

export interface Device {
  id: string | null;
  name: string;
  type: string;
  is_active: boolean;
  is_restricted: boolean;
  volume_percent: number | null;
  supports_volume?: boolean;
}

export interface Artist {
  name: string;
  uri: string;
}

export interface Track {
  name: string;
  uri: string;
  type: "track" | "episode";
  duration_ms: number;
  artists?: Artist[];
  album?: { name: string; uri: string };
  show?: { name: string };
}

export interface PlaybackState {
  device: Device;
  is_playing: boolean;
  shuffle_state: boolean;
  repeat_state: "off" | "track" | "context";
  progress_ms: number | null;
  item: Track | null;
  context: { type: string; uri: string } | null;
}

export async function getDevices(env: Env): Promise<Device[]> {
  const result = await spotify<{ devices: Device[] }>(env, "GET", "/me/player/devices");
  return result?.devices ?? [];
}

// --- Helpers ---------------------------------------------------------------

const URI_TYPES = ["track", "album", "artist", "playlist", "episode", "show"] as const;

/**
 * Accepts `spotify:track:ID` URIs or `https://open.spotify.com/(intl-xx/)track/ID?si=...`
 * links and returns the canonical URI.
 */
export function toSpotifyUri(input: string): string {
  const value = input.trim();
  if (value.startsWith("spotify:")) return value;
  try {
    const url = new URL(value);
    if (url.hostname.endsWith("spotify.com")) {
      const parts = url.pathname.split("/").filter(Boolean);
      const typeIndex = parts.findIndex((part) => (URI_TYPES as readonly string[]).includes(part));
      const id = typeIndex >= 0 ? parts[typeIndex + 1] : undefined;
      if (typeIndex >= 0 && id) return `spotify:${parts[typeIndex]}:${id}`;
    }
  } catch {
    // Not a URL; fall through.
  }
  throw new SpotifyError(`"${input}" is not a Spotify URI or open.spotify.com link.`);
}

export function describeTrack(item: Track | null | undefined): string {
  if (!item) return "nothing";
  const by = item.artists?.map((artist) => artist.name).join(", ") ?? item.show?.name;
  return by ? `"${item.name}" by ${by}` : `"${item.name}"`;
}

export function describeDevice(device: Device): string {
  const flags = [device.type, device.is_active ? "active" : null, device.is_restricted ? "restricted" : null]
    .filter(Boolean)
    .join(", ");
  const volume = device.volume_percent !== null ? `, volume ${device.volume_percent}%` : "";
  return `${device.name} (${flags}${volume})`;
}

export const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");

function deviceList(devices: Device[]): string {
  return devices.length
    ? devices.map((device) => `- ${describeDevice(device)}`).join("\n")
    : "(none — open Spotify on a phone, computer or speaker so it shows up)";
}

/** Finds a device by ID, exact name, fuzzy name, or type (e.g. "phone"). */
export function matchDevice(devices: Device[], wanted: string): Device {
  const target = wanted.trim();
  const key = normalize(target);
  const candidates = devices.filter((device) => device.id);

  const tiers: Array<(device: Device) => boolean> = [
    (device) => device.id === target,
    (device) => device.name.toLowerCase() === target.toLowerCase(),
    (device) => normalize(device.name) === key,
    (device) => key.length > 0 && normalize(device.name).includes(key),
    (device) => key.length > 0 && key.includes(normalize(device.name)),
    (device) => normalize(device.type) === key,
  ];

  for (const tier of tiers) {
    const matches = candidates.filter(tier);
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) {
      throw new SpotifyError(
        `"${wanted}" matches more than one device. Be more specific:\n${deviceList(matches)}`,
      );
    }
  }
  throw new SpotifyError(
    `No Spotify device matches "${wanted}". Devices only appear while Spotify is open on them. Available now:\n${deviceList(devices)}`,
  );
}

/**
 * Resolves which device a command should target:
 * the named device, else the active one, else DEFAULT_DEVICE, else the only device.
 * Returns undefined only when Spotify should be left to decide.
 */
export async function resolveDevice(env: Env, wanted?: string): Promise<Device | undefined> {
  const devices = await getDevices(env);
  if (wanted?.trim()) return matchDevice(devices, wanted);

  const active = devices.find((device) => device.is_active);
  if (active) return active;
  if (env.DEFAULT_DEVICE?.trim()) return matchDevice(devices, env.DEFAULT_DEVICE);
  const usable = devices.filter((device) => device.id && !device.is_restricted);
  if (usable.length === 1) return usable[0];
  throw new SpotifyError(
    `Nothing is playing right now, so I need to know which device to use. Available devices:\n${deviceList(devices)}`,
    undefined,
    "NO_ACTIVE_DEVICE",
  );
}

export async function transferPlayback(env: Env, deviceId: string, play: boolean): Promise<void> {
  await spotify(env, "PUT", "/me/player", { body: { device_ids: [deviceId], play } });
}

/**
 * Starts playback on a device. If the device was idle, Spotify sometimes refuses
 * a direct play command, so wake it with a transfer and try once more.
 */
export async function startPlayback(
  env: Env,
  device: Device | undefined,
  body: Record<string, unknown>,
): Promise<void> {
  const deviceId = device?.id ?? undefined;
  const send = () =>
    spotify(env, "PUT", "/me/player/play", {
      query: { device_id: deviceId },
      body: Object.keys(body).length ? body : undefined,
    });
  try {
    await send();
  } catch (error) {
    const retryable = error instanceof SpotifyError && (error.status === 404 || error.status === 502);
    if (!deviceId || !retryable) throw error;
    await transferPlayback(env, deviceId, false);
    await new Promise((resolve) => setTimeout(resolve, 750));
    await send();
  }
}

/** Best effort: some devices refuse shuffle changes until they are playing. */
export async function trySetShuffle(env: Env, device: Device | undefined, state: boolean): Promise<boolean> {
  try {
    await spotify(env, "PUT", "/me/player/shuffle", { query: { state, device_id: device?.id ?? undefined } });
    return true;
  } catch {
    return false;
  }
}

/**
 * Starts playback with a fixed shuffle state. Shuffle is set before playing so the
 * first track respects it, and again afterwards in case the device was idle.
 */
export async function startPlaybackWithShuffle(
  env: Env,
  device: Device | undefined,
  body: Record<string, unknown>,
  shuffle: boolean,
): Promise<void> {
  const setBefore = await trySetShuffle(env, device, shuffle);
  await startPlayback(env, device, body);
  if (!setBefore) await trySetShuffle(env, device, shuffle);
}
