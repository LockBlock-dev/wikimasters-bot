// Session commands: login (password + Turnstile) and bootstrap (browser cookies).
import { env } from "../config.ts";
import {
  cookieHeaderFromCurlFile,
  loginWithPassword,
  refreshSession,
  saveSession,
  sessionFromCookieHeader,
} from "../wikimasters/session.ts";
import { log } from "../core.ts";

export async function cmdLogin(): Promise<void> {
  const email = env("EMAIL");
  const password = env("PASSWORD");
  const captcha = env("CAPTCHA_TOKEN");
  if (!email || !password || !captcha) throw new Error("login needs EMAIL, PASSWORD and CAPTCHA_TOKEN env (fresh Turnstile token from the login page)");
  const s = await loginWithPassword(email, password, captcha);
  log(`logged in as ${s.user.email} (id ${s.user.id}), session saved`);
}

export async function cmdBootstrap(cookieFile: string): Promise<void> {
  const fromEnv = env("SESSION_COOKIE");
  const header = fromEnv ?? (await cookieHeaderFromCurlFile(cookieFile));
  const imported = sessionFromCookieHeader(header);
  // Immediately refresh so the imported (possibly near-expiry) tokens rotate into our own session.
  await saveSession(imported);
  const fresh = await refreshSession(imported);
  log(`bootstrapped session for ${fresh.user.email}, expires_at=${fresh.expires_at}`);
}
