interface Env {
  /** Client ID of your Spotify developer app. */
  SPOTIFY_CLIENT_ID: string;
  /** Client secret of your Spotify developer app. */
  SPOTIFY_CLIENT_SECRET: string;
  /** Long-lived refresh token for your account, obtained from /setup. */
  SPOTIFY_REFRESH_TOKEN?: string;
  /** Shared secret that every MCP request must present. */
  MCP_AUTH_TOKEN: string;
  /** Optional device name/ID used when nothing is active and no device is given. */
  DEFAULT_DEVICE?: string;
  /** Optional Blend playlists, one "name: link" per line (Spotify hides Blends from apps). */
  BLENDS?: string;
}
