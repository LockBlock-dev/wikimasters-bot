import { COOKIE_BASE, SESSION_FILE, SUPABASE_ANON_KEY, SUPABASE_URL, env } from "../config.ts";
import type { WikiSession } from "./types.ts";

export async function loadSession(): Promise<WikiSession | null> {
  try {
    const f = Bun.file(SESSION_FILE);
    if (!(await f.exists())) return null;
    return (await f.json()) as WikiSession;
  } catch {
    return null;
  }
}

export async function saveSession(s: WikiSession): Promise<void> {
  await Bun.write(SESSION_FILE, JSON.stringify(s, null, 2));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** POST to Supabase auth token endpoint with retries (handles flaky 525s). */
async function tokenRequest(body: Record<string, unknown>): Promise<WikiSession> {
  let lastErr = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=${(body as { grant_type: string }).grant_type}`, {
        method: "POST",
        headers: {
          apikey: SUPABASE_ANON_KEY,
          "Content-Type": "application/json;charset=UTF-8",
          "X-Client-Info": "supabase-ssr/0.9.0 createBrowserClient",
          "X-Supabase-Api-Version": "2024-01-01",
        },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`auth ${res.status}: ${text.slice(0, 300)}`);
      const sess = JSON.parse(text) as WikiSession;
      if (!sess.access_token || !sess.refresh_token) throw new Error("auth response missing tokens");
      return sess;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      await sleep(1000 * 2 ** attempt);
    }
  }
  throw new Error(`supabase auth failed after retries: ${lastErr}`);
}

export async function refreshSession(old: WikiSession): Promise<WikiSession> {
  const next = await tokenRequest({ grant_type: "refresh_token", refresh_token: old.refresh_token });
  await saveSession(next);
  return next;
}

/** Fresh email+password login. Requires a Cloudflare Turnstile captcha token. */
export async function loginWithPassword(email: string, password: string, captchaToken: string): Promise<WikiSession> {
  const sess = await tokenRequest({
    grant_type: "password",
    email,
    password,
    gotrue_meta_security: { captcha_token: captchaToken },
  });
  await saveSession(sess);
  return sess;
}

/** Returns a session with a valid (non-expired) access token, refreshing if needed. */
export async function ensureSession(): Promise<WikiSession> {
  let s = await loadSession();
  if (!s) {
    // Try bootstrapping from SESSION_COOKIE env (raw browser Cookie header)
    const rawCookie = env("SESSION_COOKIE");
    if (rawCookie) {
      s = sessionFromCookieHeader(rawCookie);
      await saveSession(s);
    } else {
      throw new Error(
        "No session found (.session.json missing). Run `bun run index.ts bootstrap --cookie-file curl.txt` or set SESSION_COOKIE, or run login with CAPTCHA_TOKEN env.",
      );
    }
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if (!s.expires_at || s.expires_at - nowSec < 120) {
    s = await refreshSession(s);
  }
  return s;
}

/** Rebuild the wiki-masters Cookie header from a Supabase session (supabase-ssr chunked format). */
export function buildWikiCookie(session: WikiSession): string {
  const b64 = Buffer.from(JSON.stringify(session)).toString("base64");
  const CHUNK = 2000;
  const chunks: string[] = [];
  for (let i = 0; i < b64.length; i += CHUNK) chunks.push(b64.slice(i, i + CHUNK));
  // supabase-ssr: `base64-` prefix only on the first chunk
  return chunks.map((c, i) => (i === 0 ? `${COOKIE_BASE}.${i}=base64-${c}` : `${COOKIE_BASE}.${i}=${c}`)).join("; ");
}

/** Parse a browser Cookie header containing sb-*-auth-token.[0..n] chunks back into a session. */
export function sessionFromCookieHeader(cookieHeader: string): WikiSession {
  const parts: Record<string, string> = {};
  for (const p of cookieHeader.split(";")) {
    const idx = p.indexOf("=");
    if (idx < 0) continue;
    parts[p.slice(0, idx).trim()] = p.slice(idx + 1).trim();
  }
  const keys = Object.keys(parts)
    .filter((k) => k.startsWith(COOKIE_BASE + "."))
    .sort((a, b) => Number(a.split(".").pop()) - Number(b.split(".").pop()));
  if (keys.length === 0) throw new Error("No auth-token cookies found in provided Cookie header");
  let joined = keys.map((k) => parts[k]!).join("");
  if (joined.startsWith("base64-")) joined = joined.slice("base64-".length);
  joined += "=".repeat((-joined.length % 4 + 4) % 4);
  const json = Buffer.from(joined, "base64").toString("utf8");
  const sess = JSON.parse(json) as WikiSession;
  if (!sess.access_token || !sess.refresh_token) throw new Error("Cookie did not contain a valid session");
  return sess;
}

/** Extract sb-*-auth-token Cookie header from a curl.txt file (first `Cookie: ...` line). */
export async function cookieHeaderFromCurlFile(path: string): Promise<string> {
  const text = await Bun.file(path).text();
  const m = text.match(/Cookie:\s*([^\n']+)/);
  if (!m?.[1]) throw new Error(`No Cookie header found in ${path}`);
  return m[1].trim().replace(/\\\s*$/, "").trim();
}
