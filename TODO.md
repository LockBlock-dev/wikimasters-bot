# TODO

## Pending user actions
- `bun run index.ts recycle --yes` — ~87 unstarred C copies → ~+87 WB (preview verified).
- `/auto_start` live test — ticks open real packs; run it when ready, then `/auto_stop`.
- Re-test recycle ✅ confirm after the callback-key + message-length fixes.

## Pending bot verification
- Recycle confirm end-to-end (colon-key bug fixed, needs live retest).
- Long-message paths (`/watch`, big previews) after the `chunked()` hard-split
  + API-layer 4000-char clamp.

## Dropped scope (user decision 2026-09-22)
- #2 market watcher — skipped for now (bidder covers the pricing logic).
- #3 pull ledger / P&L — skipped.
- #4 wishlist auto-fill — useless, the site already does it.
- #10 trade evaluator — no trading planned, ignored.

## Dropped scope (user decision 2026-09-22)
- #2 market watcher — skipped for now (bidder covers the pricing logic).
- #3 pull ledger / P&L — skipped.
- #4 wishlist auto-fill — useless, the site already does it.
- #10 trade evaluator — no trading planned, ignored.

## 1. Fresh login without a human (Turnstile)
Password grant needs a Cloudflare Turnstile token, so bot bootstrap/recovery
after session revocation currently needs a manually pasted `CAPTCHA_TOKEN`.
Verified 2026-09-22: server enforces it (`captcha_failed`, "no captcha_token
found" on token-less grant — tested once); HAR confirms the exact shape
(`log-security-event(login_attempt)` → password grant with
`gotrue_meta_security.captcha_token` → `log-security-event(login_result)`).
HAR Turnstile tokens are single-use + minutes-lived, not replayable.
- Recommended: `scripts/browser-login.ts` (Playwright + Camoufox/Chromium,
  headless) — fill EMAIL/PASSWORD, shadow-DOM-click the Turnstile checkbox,
  submit, wait for redirect, read `sb-*-auth-token.*` cookies, feed existing
  `sessionFromCookieHeader()` → `saveSession()` → `refreshSession()`.
  Wire as `login --browser`, keep `CAPTCHA_TOKEN` flow as fallback.
  Needs `bun add playwright` (or `camoufox-js`) + browser/OS deps.
- Trawl (https://github.com/germondai/trawl) as fallback tier only, not core:
  its API is fetch-only (`/v1`, `/scrape`, read-only `/mcp`, MITM proxy) with
  NO type/click/submit/eval — it auto-solves Turnstile in-page but can't hand
  us the token or submit the form. If direct browser gets edge-challenged,
  route it via Trawl (`docker compose up`, proxy `:8191`/`:8192`, Redis
  session cache) behind one env var. No Docker needed for v1.
- Option B: paid solving service (2Captcha-style, ~$1–3/1k solves).
- Turnstile is best-effort everywhere: fail loudly with a screenshot, never
  hammer retries (failed logins are telemetry-logged).
- Steady-state is unaffected (refresh-token rotation runs indefinitely;
  browser login only runs when the session actually dies).

## 3. Undiscovered room chunks (duels / parties)
Duel rooms (`/battle/duels/:id`) and party rooms (`/battle/groupe/:code`)
need a create to leak their chunk names, which spends daily quota.
- Cheapest path: create → immediately withdraw/cancel to minimize impact.
- Hypothesis to verify: duel-room wire shape mirrors battles
  (`PATCH /api/battles/:id` actions).
- Needs an active duel/party; don't burn quota just for discovery unless
  there's a real reason to play those rooms.

## 8. Quiz answering (nice to have)
- The battle wire protocol is complete (`submit_single_answer`
  `{questionId, answerId}`); *winning* needs answering Wikipedia questions
  from article content — an LLM/retrieval problem, separate from transport.
- Idea: fetch the cited article via the Wikipedia API and answer from it.

## Remaining work (not started)
- Guild tracking — standings (`/api/guilds/zevent-standings` wired) +
  contribution polling. Read-only, small.
- `bun test` mocks — dry-run blocklist, `minNextBid()`, regen math,
  cookie chunk round-trip.
- Multi-account (`​.session.<name>.json` profiles) + TUI dashboard.
- Battle/duel bot gameplay — transport + realtime room feed done
  (`src/realtime.ts`); blocked on quiz answering above.

## Telegram supervisor (built 2026-09-22, partially verified)
- `bun run index.ts telegram` = daemon: polling + owner gate + commands.
  Needs `TELEGRAM_BOT_TOKEN` + `TELEGRAM_OWNER_ID` in `.env`
  (`TELEGRAM_LOGS=1` for background pushes). Watch the `.env` key spelling
  (`TELEGRAM_OWNER_ID`, not `OWNED` — bitten once).
- Single `auto` job (`src/jobs.ts`, manual start, regen-aware sleeps,
  auto-stop after 5 failures): `/auto_start` / `/auto_stop` / `/auto_status`.
- Slash menu with emojis via `setMyCommands` (retried 3× — boot flaps);
  `/menu` button submenus (Packs/Market/Collection/Daemon), dangerous flows
  keep preview + Confirm on frozen IDs.
- All handlers + job ticks share `runExclusive` (no reply clobbering);
  single `dispatch()` serves slash + menu buttons.
- Callback keys are `chatId:seq` — split rejoins everything after the action
  (bare `[1]` lookup silently expired every confirm — fixed).
- Outbound Telegram text is clamped to 4000 chars at the `sendMessage` layer
  + `chunked()` hard-splits; failures log part lengths.
- Verified live: `/status` round-trip, plain-text log pushes, pack-open push.
  Pending: confirm flow retest, `/auto_start` live test.

## Known site behavior (verified 2026-09-22)
- `GET /api/packs/grace` → 405; claim is `POST`-only (403 for non-VIP).
  PLAN.md says "GET … expect 403" — wrong verb, code handles it.
- `POST /api/packs/pro-daily` → 403 "Réservé aux abonnés PRO" (non-PRO).
- `POST /api/packs/special` → 404 "Packs spéciaux désactivés" when no event.
- Claim success shapes unobserved (non-PRO, no active event) — assumed
  `OpenPackResult`-like, fields optional (`ClaimPackResult`).
- Marketplace browse rate-limits automation: rapid paging → 403
  "Trop de requêtes automatisées"; occasional 500 "Erreur serveur".
  Bidder uses 25/page + 2.5s spacing + graceful stop.
- `ending_soon` head is clogged with already-ended listings — bidder
  paginates past them; `recent` is livelier.
- `GET /api/marketplace/cards/:id/sales?scope=summary` 500s for some cards
  and returns `{}` (no sales) for others — callers must skip both.
- Settle is a real no-op-safe guarantee, and it actually settles now:
  `getMarketplaceMine()` was reading `GET /api/marketplace/mine`, which
  returns counts only (`{sellingCount, maxConcurrentAuctions}`) — so `won`
  was always `[]` and `settle` never fired. Fixed 2026-09-24: buckets come
  from browse with `mine=1` (`/api/marketplace?mine=1&page=1&limit=1`),
  cross-checked against direct `auctions` seller/bidder/winner filters
  (3/3/3 match). Server-side auto-settle still observed, so the command is
  usually a harmless top-up.
- `bun -e '…' --dry-run` swallows the flag (Bun quirk) — use
  `DRY_RUN=1 bun -e …` or `bun run index.ts … --dry-run`.
