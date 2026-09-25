import { isDryRun } from "./src/config.ts";
import { ensureSession, loadSession, refreshSession } from "./src/wikimasters/session.ts";
import { verifyHuman } from "./src/wikimasters/api.ts";
import { log } from "./src/core.ts";
import { cmdClaim, cmdLoop, cmdOpen, cmdStatus } from "./src/commands/packs.ts";
import { cmdBid, cmdSettle, cmdTop } from "./src/commands/market.ts";
import { cmdRecycle, cmdWishlistClean } from "./src/commands/collection.ts";
import { cmdNotify, cmdWatch } from "./src/commands/monitor.ts";
import { cmdBootstrap, cmdLogin } from "./src/commands/session.ts";
import { startTelegramBot } from "./src/bot/telegram.ts";

function usage(): void {
  console.log(`wikimasters-bot (Bun TS) — safe: read-only + pack opening. No sell/discard/delete.

Usage:
  bun run index.ts status                  show profile, packs, collection
  bun run index.ts open                    open ONE pack now (verifies human if needed)
  bun run index.ts claim                   claim free pro-daily / special / grace packs when available
  bun run index.ts verify                  run the {"website":""} human check
  bun run index.ts loop [--max-opens N]    auto-open packs, waiting for regen
  bun run index.ts login                   fresh login via EMAIL/PASSWORD + CAPTCHA_TOKEN env
  bun run index.ts bootstrap [--cookie-file curl.txt]
                                           import browser Cookie header -> .session.json
  bun run index.ts watch                   print notifications/trades/marketplace snapshot
  bun run index.ts notify [--once] [--interval S]
                                           live realtime feed + periodic resync safety net
                                           (--once = single poll, --interval = resync secs)
  bun run index.ts top [--limit N] [--skip C,PC] [--exclude-starred] [--exclude-tagged]
                                           top cards by average market value (commons skipped by default, starred+tagged included)
  bun run index.ts recycle [--yes] [--limit N]
                                           discard ALL untagged unstarred C cards (+1 WB each). Preview without --yes
  bun run index.ts bid [--yes] [--max-price N] [--factor F] [--min-secs S] [--max-total N] [--limit N] [--sort recent|ending_soon]
                                           auto-bid deals (<= avg*factor). Preview without --yes
  bun run index.ts settle                  settle finished wins (collect cards/funds)
  bun run index.ts wishlist-clean [--yes]  drop wishlisted cards you already own. Preview without --yes
  bun run index.ts telegram                Telegram control bot (needs TELEGRAM_BOT_TOKEN + OWNER_ID)
  [--dry-run]                              global: log mutating calls instead of sending

Env (.env): EMAIL, PASSWORD, CAPTCHA_TOKEN (fresh Turnstile token for login),
  SESSION_COOKIE (raw Cookie header, alternative bootstrap),
  DRY_RUN=1 (same as --dry-run),
  TELEGRAM_BOT_TOKEN + TELEGRAM_OWNER_ID (for telegram), TELEGRAM_LOGS=1 (push logs + notify events to owner chat).
Session: .session.json (auto-refreshed, git-ignored).
`);
}

/** Parse `--name value` from argv, falling back to def (0 is a valid value). */
function numFlag(args: string[], name: string, def: number): number {
  const i = args.indexOf(name);
  if (i < 0 || i + 1 >= args.length) return def;
  const n = Number(args[i + 1]);
  return Number.isFinite(n) ? n : def;
}

async function main(): Promise<void> {
  const [cmd = "loop", ...rest] = Bun.argv.slice(2);
  if (isDryRun()) log("DRY-RUN mode: mutating calls will be logged, not sent");
  if (cmd === "status") return cmdStatus();
  if (cmd === "open") return cmdOpen();
  if (cmd === "claim") return cmdClaim();
  if (cmd === "verify") {
    const s = await ensureSession();
    console.log(await verifyHuman(s));
    return;
  }
  if (cmd === "loop") {
    return cmdLoop(numFlag(rest, "--max-opens", 0));
  }
  if (cmd === "recycle") {
    await cmdRecycle(rest.includes("--yes"), numFlag(rest, "--limit", 200));
    return;
  }
  if (cmd === "bid") {
    const si = rest.indexOf("--sort");
    const sort = si >= 0 && rest[si + 1] === "ending_soon" ? "ending_soon" : "recent";
    await cmdBid({
      yes: rest.includes("--yes"),
      maxPrice: numFlag(rest, "--max-price", 50),
      factor: numFlag(rest, "--factor", 0.7),
      minSecs: numFlag(rest, "--min-secs", 120),
      maxTotal: numFlag(rest, "--max-total", 100),
      limit: numFlag(rest, "--limit", 50),
      sort,
    });
    return;
  }
  if (cmd === "settle") return cmdSettle().then(() => undefined);
  if (cmd === "wishlist-clean") {
    await cmdWishlistClean(rest.includes("--yes"));
    return;
  }
  if (cmd === "login") return cmdLogin();
  if (cmd === "bootstrap") {
    const fi = rest.indexOf("--cookie-file");
    return cmdBootstrap(fi >= 0 ? rest[fi + 1]! : "curl.txt");
  }
  if (cmd === "watch") return cmdWatch();
  if (cmd === "notify") {
    return cmdNotify(rest.includes("--once"), numFlag(rest, "--interval", 60));
  }
  if (cmd === "top") {
    const limit = numFlag(rest, "--limit", 10);
    const si = rest.indexOf("--skip");
    // Default: skip common tiers. `--skip none` includes everything, `--skip C` only skips C.
    const skip = si >= 0 ? (rest[si + 1] ?? "").split(",").map((x) => x.trim()).filter((x) => x && x.toLowerCase() !== "none") : ["C", "PC"];
    return cmdTop(limit, skip, { excludeStarred: rest.includes("--exclude-starred"), excludeTagged: rest.includes("--exclude-tagged") });
  }
  if (cmd === "refresh") {
    const s = await loadSession();
    if (!s) throw new Error("no .session.json to refresh");
    const f = await refreshSession(s);
    log(`refreshed, expires_at=${f.expires_at}`);
    return;
  }
  if (cmd === "telegram") return startTelegramBot();
  usage();
}

main().catch((e) => {
  console.error(`error: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
