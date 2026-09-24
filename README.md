# wikimasters-bot

Bun + TypeScript bot for [WikiMasters](https://www.wiki-masters.com): pack opening,
free-pack claims, marketplace bidding, collection management — controllable from
the CLI or a Telegram control bot. Read-only by default; every asset-spending
action is preview-first with explicit confirmation.

```bash
bun install
cp .env.example .env  # then fill EMAIL, PASSWORD, … (see below)
bun run index.ts status
```

## Architecture

Reads go **direct to Supabase** wherever RLS allows (collection, market
pricing, notifications, trades, chat, achievements, tags); `/api` is used only
where server logic lives (packs, bids/settles/discards, claims, billing).
`src/api.ts` keeps every route wrapper, but bot code prefers the direct path.

- `src/commands/` — `packs`, `market`, `collection`, `monitor`, `session`
  (`index.ts` is dispatch only; shared runtime in `src/core.ts`).
- `src/client.ts` — `WikiClient` session holder; `src/realtime.ts` —
  `RealtimeManager` (socket + resubscribing factories) plus channel helpers;
  `src/jobs.ts` — `AutoJob` state machine.
- `src/stealth.ts` — browser headers, jittered delays, paced requests
  (see below).
- `wm/` — reverse-engineering notes (`README.md`) + captured site chunks.
  Live browser material (`*.har`, `ws.txt`, `curl.txt`) is git-ignored.

## Commands

| Command | What it does |
|---|---|
| `status` | Profile, packs, collection, pro-daily/special state |
| `open` | Open one pack now (auto-verifies if needed) |
| `claim` | Claim free pro-daily / special / grace packs when available |
| `loop [--max-opens N]` | Verify → claim → settle → open, waiting for regen |
| `top [--limit N] [--skip C,PC]` | Top unstarred cards by average market value (fully direct: collection + bulk settled sales) |
| `bid [--yes] [--max-price N] [--factor F] [--min-secs S] [--max-total N] [--limit N] [--sort recent\|ending_soon]` | Bid `minNextBid()` on listings under `avg × factor`. Direct scan + pricing, `--limit` counts priced candidates. Preview without `--yes`; daily spend file `.bid-spend.json` |
| `recycle [--yes] [--limit N]` | Discard ALL unstarred C cards (+1 WB each). Preview without `--yes`; end balance from one profile read, start derived |
| `settle` | Settle finished wins via direct `won` bucket (collect cards/funds) |
| `wishlist-clean [--yes]` | Drop wishlisted cards you already own. Preview without `--yes` |
| `watch` | One-shot dump: notifications, trades, marketplace, specials (direct reads) |
| `notify [--once] [--interval S]` | Live realtime notifications feed + periodic resync to Telegram (`--once` = single poll; push needs `TELEGRAM_LOGS=1`) |
| `telegram` | Control-bot daemon (polling). See below |
| `login` / `bootstrap` / `refresh` / `verify` | Session management |

## Safety

- `--dry-run` / `DRY_RUN=1`: every mutating call (`wikiMutate` + Supabase
  writes) logs instead of sending. Reads, pack opens and free claims are
  never blocked.
- Dangerous CLI commands preview without `--yes`. Telegram dangerous flows
  preview + inline ✅/❌ Confirm on frozen IDs (bids revalidate live price).
- Starred cards are never touched by `recycle`/`top`.

## Stealth

- Browser `User-Agent` + headers on every request (no bot UA), jittered
  delays, paced paging/writes, realtime feed instead of polling.
- Known residual risk: Bun's TLS fingerprint differs from Chrome — a real
  browser is the only full fix for sensitive flows.

## Env (`.env`, git-ignored)

| Key | Purpose |
|---|---|
| `EMAIL`, `PASSWORD` | Supabase password grant (needs fresh `CAPTCHA_TOKEN` — Turnstile) |
| `CAPTCHA_TOKEN` | Fresh Turnstile token from `/login` (see TODO #1) |
| `SESSION_COOKIE` | Alt bootstrap: raw browser Cookie header |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_OWNER_ID` (+ `TELEGRAM_LOGS=1`) | Control bot (owner-gated, polling) + notify pushes |
| `DRY_RUN=1` | Same as `--dry-run` |

Session: `.session.json` (auto-refreshed, git-ignored). First run with no
session: `bun run index.ts bootstrap --cookie-file curl.txt`.

## Telegram daemon

`bun run index.ts telegram` — owner-gated polling bot (`TELEGRAM_OWNER_ID`
checked on every update, strangers dropped silently). Slash menu with emojis
(`setMyCommands`), `/menu` button submenus (Packs/Market/Collection/Daemon),
single `auto` job (verify + claim + settle + open, regen-aware):
`/auto_start` · `/auto_stop` · `/auto_status`. All handlers and job ticks
share one mutex, so replies never interleave.
