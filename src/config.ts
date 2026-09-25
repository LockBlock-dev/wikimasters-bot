export const SUPABASE_URL = "https://cyrxjeppjqsxxjayfrur.supabase.co";
export const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN5cnhqZXBwanFzeHhqYXlmcnVyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM4ODAzMzksImV4cCI6MjA4OTQ1NjMzOX0.BZluyXygNxuQGDPxFX1zG5i-cqp10CVK-8GGtuak4Rg";
export const SITE_URL = "https://www.wiki-masters.com";
export const COOKIE_BASE = "sb-cyrxjeppjqsxxjayfrur-auth-token";

export const MAX_PACKS = 10;
export const PACK_REGEN_MS = 6e5; // 10 min (free)
export const PACK_REGEN_PRO_MS = 18e4; // 3 min (PRO)
export const HUMAN_VERIFY_MS = 432e5; // 12 h

export const SESSION_FILE = Bun.fileURLToPath(new URL("../.session.json", import.meta.url));

export const SEEN_NOTIFICATIONS_FILE = Bun.fileURLToPath(new URL("../.notifications-seen.json", import.meta.url));

// Daily bidder spend tracker. Lives here (not in commands/market.ts) so the
// `../` depth holds both in source (src/config.ts) and in the Docker bundle
// (dist/index.js) — a per-file relative URL would escape the workdir there.
export const BID_SPEND_FILE = Bun.fileURLToPath(new URL("../.bid-spend.json", import.meta.url));

export function env(name: string): string | undefined {
  const v = Bun.env[name];
  return v && v.length > 0 ? v : undefined;
}

/**
 * Global dry-run flag: `--dry-run` argv or `DRY_RUN=1` env.
 * When on, @dangerous API functions log the request instead of sending it.
 * Read-only + free pack open/claim calls are unaffected.
 */
export function isDryRun(argv: string[] = Bun.argv): boolean {
  if (argv.includes("--dry-run")) return true;
  const v = Bun.env["DRY_RUN"];
  return v === "1" || v?.toLowerCase() === "true";
}
