import { createMcpHandler, type McpHttpHandler } from "@modelcontextprotocol/server";
import { cleanSecret, createState, isAuthorized, verifyState } from "./auth";
import { SPOTIFY_SCOPES, SpotifyError, exchangeCode } from "./spotify";
import { createServer } from "./tools";

// Env is fixed for the lifetime of a deployment, so one handler per isolate is enough.
let mcpHandler: McpHttpHandler | undefined;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === "/mcp" || pathname.startsWith("/mcp/")) {
      if (!cleanSecret(env.MCP_AUTH_TOKEN)) {
        return new Response("MCP_AUTH_TOKEN is not set on this Worker.", { status: 500 });
      }
      if (!(await isAuthorized(request, env, "/mcp"))) {
        return new Response("Unauthorized", { status: 401 });
      }
      mcpHandler ??= createMcpHandler(() => createServer(env), {
        onerror: (error) => console.error("MCP error:", error),
      });
      return mcpHandler.fetch(request);
    }

    if (pathname === "/setup" || pathname.startsWith("/setup/")) {
      if (!cleanSecret(env.MCP_AUTH_TOKEN)) {
        return html("Missing secret", `<p>The Worker can't see an <code>MCP_AUTH_TOKEN</code> secret. ${SECRET_HELP}</p>`, 500);
      }
      if (!(await isAuthorized(request, env, "/setup"))) {
        return html(
          "Unauthorized",
          "<p>The token in this URL doesn't match the Worker's <code>MCP_AUTH_TOKEN</code> secret. Open <code>/setup/&lt;MCP_AUTH_TOKEN&gt;</code> with exactly the same value.</p>",
          401,
        );
      }
      return startSetup(request, env);
    }

    if (pathname === "/callback") return finishSetup(request, env);

    if (pathname === "/") return status(env);
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

const SECRET_HELP =
  "Add it as a GitHub secret (repo <strong>Settings → Environments → production</strong>), then run the <strong>Deploy</strong> workflow under the repo's Actions tab.";

/** Shows which secrets the running Worker can see (never their values). */
function status(env: Env): Response {
  const names = ["SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET", "MCP_AUTH_TOKEN", "SPOTIFY_REFRESH_TOKEN"] as const;
  const rows = names.map((name) => `${cleanSecret(env[name]) ? "✓" : "✗"} ${name}`).join("\n");
  return new Response(`Spotify MCP server is running.\n\nSecrets visible to this Worker:\n${rows}\n`, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

// --- One-time Spotify account linking --------------------------------------

function callbackUrl(request: Request): string {
  return new URL("/callback", request.url).toString();
}

async function startSetup(request: Request, env: Env): Promise<Response> {
  if (!cleanSecret(env.SPOTIFY_CLIENT_ID) || !cleanSecret(env.SPOTIFY_CLIENT_SECRET)) {
    return html("Missing secrets", "<p>Set <code>SPOTIFY_CLIENT_ID</code> and <code>SPOTIFY_CLIENT_SECRET</code> first.</p>", 500);
  }
  const authorize = new URL("https://accounts.spotify.com/authorize");
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: cleanSecret(env.SPOTIFY_CLIENT_ID),
    scope: SPOTIFY_SCOPES.join(" "),
    redirect_uri: callbackUrl(request),
    state: await createState(env.MCP_AUTH_TOKEN),
    show_dialog: "true",
  }).toString();
  return Response.redirect(authorize.toString(), 302);
}

async function finishSetup(request: Request, env: Env): Promise<Response> {
  const params = new URL(request.url).searchParams;
  if (!(await verifyState(env.MCP_AUTH_TOKEN, params.get("state")))) {
    return html("Link expired", "<p>This link is invalid or expired. Start again from <code>/setup/&lt;MCP_AUTH_TOKEN&gt;</code>.</p>", 400);
  }
  const error = params.get("error");
  const code = params.get("code");
  if (error || !code) return html("Spotify declined", `<p>Spotify returned: <code>${escape(error ?? "no code")}</code></p>`, 400);

  try {
    const token = await exchangeCode(env, code, callbackUrl(request));
    if (!token.refresh_token) throw new SpotifyError("Spotify did not return a refresh token.");
    const me = (await fetch("https://api.spotify.com/v1/me", {
      headers: { Authorization: `Bearer ${token.access_token}` },
    }).then((response) => response.json())) as { display_name?: string; id?: string };

    return html(
      "Spotify linked",
      `<p>Signed in as <strong>${escape(me.display_name ?? me.id ?? "unknown")}</strong>.</p>
<p>Copy this refresh token and save it as the GitHub secret <code>SPOTIFY_REFRESH_TOKEN</code>
(repo Settings → Environments → production), then run the <strong>Deploy</strong> workflow again from the Actions tab:</p>
<textarea readonly rows="4" onclick="this.select()">${escape(token.refresh_token)}</textarea>
<p>Treat it like a password. This page isn't stored anywhere; close it once you've saved the secret.</p>`,
    );
  } catch (err) {
    const message = err instanceof SpotifyError ? err.message : String(err);
    return html("Setup failed", `<p>${escape(message)}</p>`, 500);
  }
}

function escape(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function html(title: string, body: string, status = 200): Response {
  const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer"><title>${escape(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;line-height:1.5}
textarea{width:100%;font-family:ui-monospace,monospace}code{background:#8882;padding:0 .25em;border-radius:3px}</style>
</head><body><h1>${escape(title)}</h1>${body}</body></html>`;
  return new Response(page, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Frame-Options": "DENY",
    },
  });
}
