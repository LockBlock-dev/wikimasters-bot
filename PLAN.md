# WikiMasters Bot — Plan

Ideas backlog. Risk legend: ✅ safe (read-only / free) · ⚠️ dangerous (spends account assets: cards, wikibidous).

## Phase 1 — Safe wins

### 1. Pro-daily + special packs auto-claim ✅
- Endpoints: `GET/POST /api/packs/pro-daily`, `GET/POST /api/packs/special` (`GET /api/packs/grace` is VIP-only, expect 403).
- Add `claimProDaily()` / `claimSpecialPack()` to `src/wikimasters/api.ts` + `ProPackResult` types in `src/wikimasters/types.ts`.
- Wire into the `loop` command: check eligibility each iteration, claim when available.
- Free cards, no spend.

### 2. Market watcher / sniper alerts ✅
- Poll `browseMarketplace()` (sorted `recent` / `ending_soon`), compare each auction's `effective_bid` to bulk settled-sales averages from `auctions` (`status=eq.settled_sold`, grouped by `snapshot_rarity` + `is_shiny`, see `wm/README.md` §5b).
- Log + optional Telegram notify when `effective_bid < average × threshold` (configurable, default 0.7).
- Strictly read-only; bidding stays manual until Phase 2.

### 3. Pull ledger + P&L tracking ✅
- Append every pack open, bid, settle, discard, and `getWikibidousBalance()` snapshot to a local ledger (`data/ledger.sqlite` or JSONL).
- Track pull rarity distribution vs `pity_counter`, and flip profit per card.
- New module: `src/ledger.ts`.

### 4. Wishlist auto-fill ✅
- Reverse the wishlist add/remove endpoints (site shows "Ajouter à la liste de souhaits" per card).
- Detect missing cards from `getCollectionStats()` and add them; wishlist hits already arrive via `/api/notifications`.

### 5. Notifications daemon ✅
- Poll `/api/notifications`, track seen ids, push `marketplace_outbid` / `auction_won` / `auction_sold` events to Telegram.
- New module: `src/bot/notify.ts`.

### 6. Dry-run mode ✅
- Global `--dry-run` flag / `DRY_RUN=1` env: dangerous functions log the request instead of sending it.
- Lets every Phase 2 strategy be tested safely first.

## Phase 2 — Dangerous (guardrailed)

All of these require: explicit CLI opt-in (no auto-run), per-day spend cap, `--dry-run` support, and confirmation for irreversible calls (discard).

### 7. Auto-bidder ⚠️
- `placeBid()` up to `min(average × factor, maxBudget)`; skip auctions ending in < N seconds; never exceed daily cap.
- Uses `minNextBid()` (site rule: `max(ceil(1.1×), +1)`).

### 8. Auto-settle + relist ⚠️
- `settleAuction()` finished wins; re-list unsold via `listCardOnMarket()` at adjusted price; midpoint `repriceAuction()` nudges.
- Track escrowed cards so nothing is forgotten in auctions.

### 9. Duplicate recycler ⚠️
- Keep N copies per card (configurable, default 1–2), `bulkDiscardCards()` the excess commons for +1 wikibidou each.
- Never touch last copies of SR/UR/L without explicit confirmation.

### 10. Trade evaluator ⚠️
- Reverse trade detail/accept endpoints (only `GET /api/trades?active=1` is wired today).
- Price both sides via market averages; accept only if value ratio ≥ threshold; otherwise alert.

## Phase 3 — Bigger projects

### 11. Duel/battle bot
- Reverse battle endpoints (site has daily quiz battles, `BATTLE_CHALLENGES_PER_DAY_*` constants in JS).
- Needs question-answer strategy from owned cards' article data.

### 12. Guild features
- Standings endpoints exist (`/api/guilds/zevent-standings`); add guild info + contribution tracking.

### 13. Tests
- `bun test` with mocked fetch: safety blocklist (dangerous paths blocked, safe reads allowed), regen-timing math, `minNextBid()`, cookie chunk round-trip.

### 14. Multi-account + TUI dashboard
- Multiple `.session.<name>.json` profiles, one `status` view across accounts; optional terminal dashboard for loop/watcher state.
