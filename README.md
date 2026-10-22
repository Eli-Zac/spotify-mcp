# Spotify MCP (Cloudflare Worker)

A private, single-user [MCP](https://modelcontextprotocol.io) server that lets Claude control Spotify playback on your devices. When Claude picks a song it can start it, and you can say which device to use ("play something chill **on the kitchen speaker**").

It runs as one Cloudflare Worker with no databases or other bindings. Your Spotify credentials are stored as Worker secrets, and every request has to present a secret token, so only you can use it.

## Tools

| Tool | What it does |
| --- | --- |
| `play` | Plays tracks (`uris`), an album/playlist/artist (`context_uri`), or the best match for a `query`. With no arguments it resumes playback. Takes an optional `device`. |
| `pause` | Pauses playback. |
| `skip` | Skips to the next or previous track. |
| `list_devices` | Lists your Spotify Connect devices and shows which one is active. |
| `transfer_playback` | Moves playback to another device. |
| `get_playback` | Shows what's playing and where. |
| `search` | Searches tracks, albums, artists or playlists. |
| `add_to_queue` | Adds a track to the queue by URI or search. |
| `set_volume` | Sets the volume from 0 to 100. |
| `set_playback_options` | Turns shuffle on or off and sets the repeat mode. |
| `list_my_playlists` | Lists your playlists so Claude can play them. |

**Devices** can be given by name, part of a name ("kitchen", "iphone"), type ("phone", "speaker", "computer", "tv") or ID. If you don't name one, the server picks in this order: the device that's playing now, then `DEFAULT_DEVICE` (if you set it), then your only device if there's just one. Otherwise it asks Claude to choose. A device only shows up while Spotify is open on it.

> Controlling playback needs **Spotify Premium**. That's a Spotify API rule.

## Setup

### 1. Create a Spotify app

1. Go to <https://developer.spotify.com/dashboard> and click **Create app**.
2. Tick **Web API**.
3. Add this redirect URI, using your own workers.dev subdomain (it's shown in the Cloudflare dashboard under *Workers & Pages*):
   `https://spotify-mcp.<your-subdomain>.workers.dev/callback`
4. Save. Then copy the **Client ID** and **Client secret** from *Settings*.

### 2. Make an access token for the MCP endpoint

This is the password that keeps the server private. Generate a long random string, for example:

```sh
openssl rand -hex 32
```

### 3. Deploy on Cloudflare

1. In the Cloudflare dashboard, go to **Workers & Pages → Create → Import a repository** and pick this repo. Keep the defaults: the project name `spotify-mcp`, which must match `name` in `wrangler.jsonc`, and the deploy command `npx wrangler deploy`.
2. Once it has deployed, open the Worker, go to **Settings → Variables and Secrets**, and add these as **Secret** values:

   | Name | Value |
   | --- | --- |
   | `SPOTIFY_CLIENT_ID` | from step 1 |
   | `SPOTIFY_CLIENT_SECRET` | from step 1 |
   | `MCP_AUTH_TOKEN` | from step 2 |

   Don't commit these to GitHub or put them in the build settings. Worker secrets are encrypted, the running Worker can read them, and they're kept on every redeploy.

### 4. Link your Spotify account (one time)

1. Open `https://spotify-mcp.<your-subdomain>.workers.dev/setup/<MCP_AUTH_TOKEN>` in your browser.
2. Approve access on Spotify. You'll come back to a page that shows a refresh token.
3. Add that token as another **Secret** called `SPOTIFY_REFRESH_TOKEN`.

### 5. Connect Claude

**Claude (web, desktop and mobile):** go to **Settings → Connectors → Add custom connector** and use this URL, with no OAuth settings:

```
https://spotify-mcp.<your-subdomain>.workers.dev/mcp/<MCP_AUTH_TOKEN>
```

**Claude Code** can send the token as a header instead:

```sh
claude mcp add --transport http spotify https://spotify-mcp.<your-subdomain>.workers.dev/mcp \
  --header "Authorization: Bearer <MCP_AUTH_TOKEN>"
```

Then try: *"Pick a good song for a rainy morning and play it on my phone"*, *"move it to the living room speaker"*, *"stop the music"*.

### Optional: default device

Add a plain-text variable `DEFAULT_DEVICE` (for example `Kitchen Speaker`). It's used when nothing is playing and you don't name a device.

## Privacy and security

- Requests to `/mcp` or `/setup` without the right token get `401`. The token is compared in constant time.
- The server only ever acts as the one Spotify account whose refresh token you saved. A new Spotify app in Development Mode also only lets users you add in the Spotify dashboard log in.
- The connector URL contains your token, so treat the whole URL like a password. If it leaks, change `MCP_AUTH_TOKEN` and update the connector.
- To cut off access completely, remove the app at <https://www.spotify.com/account/apps/>.

## Local development

```sh
npm install
cp .dev.vars.example .dev.vars   # fill in the values
npm run dev                       # http://127.0.0.1:8787
npm run typecheck
```

For local `/setup`, also add `http://127.0.0.1:8787/callback` as a redirect URI in your Spotify app. Spotify doesn't accept `localhost`, so open `http://127.0.0.1:8787/setup/<token>`.

## Troubleshooting

- **"No Spotify device matches…" or "Nothing is playing…"**: open Spotify on the device you want. Asleep or closed devices aren't listed.
- **"Spotify rejected the refresh token"**: run `/setup/<token>` again and update `SPOTIFY_REFRESH_TOKEN`. Refresh tokens can expire or be revoked.
- **`INVALID_CLIENT: Invalid redirect URI`** during setup: the redirect URI in the Spotify dashboard has to match `https://<your-worker-host>/callback` exactly.
- **Logs**: open the Worker in the Cloudflare dashboard and go to **Observability**.
