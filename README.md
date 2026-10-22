# Spotify MCP (Cloudflare Worker)

A private, single-user [MCP](https://modelcontextprotocol.io) server that lets Claude control Spotify playback on your devices. When Claude picks a song it can start it, and you can say which device to use ("play something chill **on the kitchen speaker**").

It runs as one Cloudflare Worker with no databases or other bindings. Your credentials live in GitHub secrets, and GitHub Actions copies them into the Worker when it deploys. Every request has to present a secret token, so only you can use it.

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
| `play_playlist` | Plays one of your playlists by (rough) name, in normal order, shuffled, **newest to oldest** or oldest to newest (by date added). |
| `play_liked_songs` | Plays your Liked Songs: newest first, oldest first, or shuffled. |
| `play_blend` | Plays your Blend with someone ("play my blend with jak" finds Jack). |

**Devices** can be given by name, part of a name ("kitchen", "iphone"), type ("phone", "speaker", "computer", "tv") or ID. If you don't name one, the server picks in this order: the device that's playing now, then `DEFAULT_DEVICE` (if you set it), then your only device if there's just one. Otherwise it asks Claude to choose. A device only shows up while Spotify is open on it.

> Controlling playback needs **Spotify Premium**. That's a Spotify API rule.

## Setup

### 1. Create a Spotify app

1. Go to <https://developer.spotify.com/dashboard> and click **Create app**.
2. Tick **Web API**.
3. Add this redirect URI. The host is your Worker's custom domain, or `spotify-mcp.<your-subdomain>.workers.dev`:
   `https://<your-worker-host>/callback`
4. Save. Then copy the **Client ID** and **Client secret** from *Settings*.

### 2. Make an access token for the MCP endpoint

This is the password that keeps the server private. Generate a long random string, for example:

```sh
openssl rand -hex 32
```

### 3. Add the secrets to GitHub

Pushes to `main` are deployed by GitHub Actions (`.github/workflows/deploy.yml`). The workflow copies your GitHub secrets into the Worker and then deploys it.

1. **Create a Cloudflare API token.** In the Cloudflare dashboard, go to **My Profile → API Tokens → Create Token** and use the **Edit Cloudflare Workers** template.
2. **Add the secrets in GitHub.** In the repo, go to **Settings → Environments → New environment** and name it `production`. Add these as **Environment secrets**. Plain repository secrets under *Settings → Secrets and variables → Actions* work too.

   | Secret | Value |
   | --- | --- |
   | `CLOUDFLARE_API_TOKEN` | the token from step 3.1 |
   | `SPOTIFY_CLIENT_ID` | from step 1 |
   | `SPOTIFY_CLIENT_SECRET` | from step 1 |
   | `MCP_AUTH_TOKEN` | from step 2 |
   | `SPOTIFY_REFRESH_TOKEN` | leave it out for now; you get it in step 4 |

3. **Run the workflow.** Go to **Actions → Deploy → Run workflow**, or push to `main`.
4. **Turn off Cloudflare's own Git builds**, so each push isn't deployed twice. In the Cloudflare dashboard, go to **Workers & Pages → spotify-mcp → Settings → Build** and disconnect the repository.

A secret you leave out of GitHub isn't touched, so the Worker keeps whatever value it already has. You can check which secrets the Worker can see at `https://<your-worker-host>/`. It shows ✓ or ✗ for each one and never shows the values.

### 4. Link your Spotify account (one time)

1. Open `https://<your-worker-host>/setup/<MCP_AUTH_TOKEN>` in your browser.
2. Approve access on Spotify. You'll come back to a page that shows a refresh token.
3. Add that token as the GitHub secret `SPOTIFY_REFRESH_TOKEN`, then run the **Deploy** workflow again.

### 5. Connect Claude

**Claude (web, desktop and mobile):** go to **Settings → Connectors → Add custom connector** and use this URL, with no OAuth settings:

```
https://<your-worker-host>/mcp/<MCP_AUTH_TOKEN>
```

**Claude Code** can send the token as a header instead:

```sh
claude mcp add --transport http spotify https://<your-worker-host>/mcp \
  --header "Authorization: Bearer <MCP_AUTH_TOKEN>"
```

Then try: *"Pick a good song for a rainy morning and play it on my phone"*, *"move it to the living room speaker"*, *"stop the music"*.

### Optional: Blends

Spotify hides Blend playlists from apps, so list yours once in a GitHub **variable** called `BLENDS` (repo **Settings → Secrets and variables → Actions → Variables**, or the `production` environment). Put one Blend per line as `name: link`:

```
Jack: https://open.spotify.com/playlist/37i9dQZF1EJ...
Rhylan: https://open.spotify.com/playlist/37i9dQZF1EJ...
```

To get a link, open the Blend in the Spotify app, then go to **⋯ → Share → Copy link**. Run the Deploy workflow afterwards. Names are matched loosely, so "jak" finds Jack and "rylan" finds Rhylan.

### Optional: default device

Add a GitHub variable or secret called `DEFAULT_DEVICE` (for example `Kitchen Speaker`) and run the workflow again. It's used when nothing is playing and you don't name a device.

## Notes on ordering

- Sorting a playlist **newest to oldest** reads its tracks and their "date added". Spotify only allows that for playlists you own or collaborate on; other playlists can still be played in order or shuffled.
- A sorted playlist, or Liked Songs oldest first, plays up to 100 tracks as a queue. Liked Songs newest first plays your whole library.

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
- **"Spotify rejected the refresh token"**: run `/setup/<token>` again, update the `SPOTIFY_REFRESH_TOKEN` GitHub secret and re-run the workflow. Refresh tokens can expire or be revoked.
- **Secrets show ✗ on the status page**: check that the Deploy workflow ran without errors, and that its "Sync secrets" step lists them. Its log never shows the values.
- **`INVALID_CLIENT: Invalid redirect URI`** during setup: the redirect URI in the Spotify dashboard has to match `https://<your-worker-host>/callback` exactly.
- **"missing a permission"** when playing Liked Songs: Liked Songs needs a permission added after your first setup. Run `/setup/<token>` again, update `SPOTIFY_REFRESH_TOKEN` and re-run the workflow.
- **Logs**: open the Worker in the Cloudflare dashboard and go to **Observability**.
