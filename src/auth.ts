const encoder = new TextEncoder();

async function sha256(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", encoder.encode(value));
}

/** Constant-time string comparison (hashing first so lengths always match). */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sha256(a), sha256(b)]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

/**
 * Pulls the caller's token from either `Authorization: Bearer <token>` or the
 * last path segment (`/mcp/<token>`, `/setup/<token>`). The path form exists
 * because the Claude apps' custom connector dialog can't send custom headers.
 */
export function extractToken(request: Request, prefix: string): string | null {
  const header = request.headers.get("Authorization");
  if (header?.startsWith("Bearer ")) return header.slice("Bearer ".length).trim();

  const { pathname } = new URL(request.url);
  if (pathname.startsWith(`${prefix}/`)) {
    const token = decodeURIComponent(pathname.slice(prefix.length + 1));
    return token || null;
  }
  return null;
}

export async function isAuthorized(request: Request, env: Env, prefix: string): Promise<boolean> {
  if (!env.MCP_AUTH_TOKEN) return false;
  const token = extractToken(request, prefix);
  return token !== null && (await safeEqual(token, env.MCP_AUTH_TOKEN));
}

// --- Signed OAuth `state` for the one-time /setup flow ---------------------

const STATE_MAX_AGE_MS = 10 * 60 * 1000;

function base64url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return base64url(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

export async function createState(secret: string): Promise<string> {
  const payload = `${Date.now()}.${crypto.randomUUID()}`;
  return `${payload}.${await hmac(secret, payload)}`;
}

export async function verifyState(secret: string, state: string | null): Promise<boolean> {
  if (!state) return false;
  const lastDot = state.lastIndexOf(".");
  if (lastDot < 0) return false;
  const payload = state.slice(0, lastDot);
  const signature = state.slice(lastDot + 1);
  if (!(await safeEqual(signature, await hmac(secret, payload)))) return false;
  const issuedAt = Number(payload.split(".")[0]);
  return Number.isFinite(issuedAt) && Date.now() - issuedAt < STATE_MAX_AGE_MS;
}
