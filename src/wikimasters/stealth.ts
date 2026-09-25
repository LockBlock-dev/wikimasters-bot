// Stealth: blend bot traffic with normal browser usage.
//
// The site rate-limits automation (403 "Trop de requêtes automatisées") and
// telemetry-logs logins, so: real browser headers, no bot User-Agent,
// jittered delays on every network path, paced paging/writes. Behavioral
// rules: never hammer, never metronomic, batch during plausible hours is the
// caller's choice (nothing here schedules 24/7 by itself).
//
// Known residual risk: Bun's TLS fingerprint differs from Chrome's. A real
// browser (Playwright, cf. TODO #1) is the only full fix for sensitive flows.

import { SITE_URL } from "../config.ts";

export const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36";

/** Client tag the site itself sends (supabase-ssr createBrowserClient). */
export const SUPABASE_CLIENT_INFO = "supabase-ssr/0.9.0 createBrowserClient";

/** Same-origin browser headers for /api calls (merged with the Cookie). */
export function browserHeaders(referer = `${SITE_URL}/`): Record<string, string> {
  return {
    "User-Agent": BROWSER_UA,
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
    "Sec-CH-UA": '"Chromium";v="154", "Google Chrome";v="154", "Not-A.Brand";v="99"',
    "Sec-CH-UA-Mobile": "?0",
    "Sec-CH-UA-Platform": '"Windows"',
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    Referer: referer,
  };
}

/** Cross-site browser headers for direct Supabase REST (the site's client). */
export function supabaseHeaders(): Record<string, string> {
  return {
    "User-Agent": BROWSER_UA,
    Origin: SITE_URL,
    Referer: `${SITE_URL}/`,
    "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
  };
}

/** Random delay in [minMs, maxMs]. */
export function humanDelay(minMs: number, maxMs: number): Promise<void> {
  const ms = minMs + Math.random() * Math.max(0, maxMs - minMs);
  return new Promise((r) => setTimeout(r, ms));
}

/** ms with ±spread jitter (clamped ≥0). */
export function jitter(ms: number, spread = 0.3): number {
  return Math.max(0, Math.round(ms + ms * spread * (Math.random() * 2 - 1)));
}

export async function jitteredSleep(ms: number, spread = 0.3): Promise<void> {
  return new Promise((r) => setTimeout(r, jitter(ms, spread)));
}
