// Market commands: top (valuation), bid (auto-bidder), settle (collect wins).
import { isDryRun } from "../config.ts";
import { ensureSession } from "../wikimasters/session.ts";
import { minNextBid, placeBid, settleAuction } from "../wikimasters/api.ts";
import type { Auction } from "../wikimasters/types.ts";
import { log } from "../core.ts";
import { humanDelay } from "../wikimasters/stealth.ts";
import {
  browseAuctionsDirect,
  getAuctionRow,
  getMyCollectionDirect,
  getMyMarketBuckets,
  getPublicCards,
  getSettledSales,
  getTaggedUserCardIds,
  statsForSales,
} from "../wikimasters/supabase.ts";

export interface TopOpts {
  excludeStarred?: boolean;
  excludeTagged?: boolean;
}

export async function cmdTop(limit: number, skip: string[], opts: TopOpts = {}): Promise<void> {
  const s = await ensureSession();
  const skipSet = new Set(skip.map((r) => r.toUpperCase()));
  // Own collection via direct reads (no /api paging).
  const all = await getMyCollectionDirect(s);
  const pool = all.filter((it) => !skipSet.has((it.card.rarity ?? "").toUpperCase()));
  const skippedCommon = all.length - pool.length;
  let tagged = new Set<string>();
  let skippedTagged = 0;
  if (opts.excludeTagged) {
    tagged = await getTaggedUserCardIds(s, pool.map((t) => t.id));
  }
  const seen = new Map();
  let skippedStarred = 0;
  for (const it of pool) {
    if (tagged.has(it.id)) {
      skippedTagged++;
      continue;
    }
    if (opts.excludeStarred && it.starred) {
      skippedStarred++;
      continue;
    }
    if (seen.has(it.card_id)) continue;
    seen.set(it.card_id, it);
  }
  const candidates = [...seen.values()];
  log(`${all.length} copies (${skippedStarred} starred skipped, ${skippedTagged} tagged skipped, ${skippedCommon} ${[...skipSet].join("/") || "none"} skipped), ${candidates.length} distinct candidates — pricing...`);
  // Bulk pricing via direct `auctions` reads (settled_sold). No API fallback:
  // cards with no settled sales are skipped.
  const priced: Array<{ title: string; rarity: string; avg: number; latest?: number; count?: number }> = [];
  const rows = await getSettledSales(s, candidates.map((it) => it.card_id));
  for (const it of candidates) {
    const rarity = (it.snapshot_rarity ?? it.card.rarity ?? "") as string;
    const st = statsForSales(rows, it.card_id, rarity || undefined, it.is_shiny ?? undefined);
    if (!st) continue;
    priced.push({ title: it.card.wikipedia_title, rarity, avg: st.average, latest: st.latest, count: st.count });
  }
  priced.sort((a, b) => b.avg - a.avg);
  log(`top ${Math.min(limit, priced.length)} by average market value (${priced.length} with sales data):`);
  priced.slice(0, limit).forEach((c, i) => {
    log(`  ${i + 1}. ${c.title} [${c.rarity}] avg=${Math.round(c.avg)}${c.latest != null ? ` latest=${c.latest}` : ""}${c.count != null ? ` sales=${c.count}` : ""}`);
  });
}

export interface BidOpts {
  yes: boolean;
  maxPrice: number;
  factor: number;
  minSecs: number;
  maxTotal: number;
  limit: number;
  sort: "recent" | "ending_soon";
}

const BID_SPEND_FILE = Bun.fileURLToPath(new URL("../../.bid-spend.json", import.meta.url));

async function loadBidSpend(): Promise<{ date: string; spent: number }> {
  const today = new Date().toISOString().slice(0, 10);
  try {
    const f = Bun.file(BID_SPEND_FILE);
    if (await f.exists()) {
      const d = (await f.json()) as { date: string; spent: number };
      if (d.date === today) return d;
    }
  } catch {
    // fall through to fresh
  }
  return { date: today, spent: 0 };
}

/**
 * @dangerous Auto-bidder: bids minNextBid() on auctions priced under
 * min(avg × factor, maxPrice). Skips own auctions, auctions already led,
 * auctions ending in < minSecs, and stops at the daily maxTotal cap.
 * Preview without --yes; --dry-run also blocks sends via wikiMutate.
 */
export interface BidDecision {
  id: string;
  title: string;
  next: number;
  avg: number;
  cap: number;
  endsIn: number;
}

export async function cmdBid(o: BidOpts, only?: BidDecision[]): Promise<BidDecision[]> {
  const s = await ensureSession();
  const me = s.user.id;
  const spend = await loadBidSpend();
  log(`bid: sort=${o.sort} factor=${o.factor} maxPrice=${o.maxPrice} minSecs=${o.minSecs} daily ${spend.spent}/${o.maxTotal} (day ${spend.date})${o.yes ? "" : " PREVIEW only"}`);
  let bids = 0;
  let evaluated = 0; // every auction seen (for the summary line)
  let considered = 0; // passed cheap filters — --limit applies here, not to skips
  const skip: Record<string, number> = { mine: 0, leading: 0, ending: 0, noavg: 0, overcap: 0 };
  const bump = (k: string): void => {
    skip[k] = (skip[k] ?? 0) + 1;
  };
  // ending_soon page 1 is clogged with already-ended listings — paginate past them.
  // The site rate-limits automated browsing (403), so pages are small, spaced out,
  // and a 403 stops the scan gracefully instead of crashing.
  // Phase 1 (no pricing calls): cheap filters only. Pricing is one bulk read
  // afterwards — one sequential call per auction was far too slow.
  const survivors: Array<{ a: Auction; title: string; next: number; endsIn: number }> = [];
  for (let page = 0; page < 6 && considered < o.limit; page++) {
    if (page > 0) await humanDelay(2200, 4200); // paced + jittered browse
    let auctions: Auction[] = [];
    let hasMore = false;
    try {
      const r = await browseAuctionsDirect(s, { sort: o.sort, limit: 25, page });
      auctions = r.auctions;
      hasMore = r.hasMore;
    } catch (e) {
      log(`browse page ${page} failed, stopping scan: ${e instanceof Error ? e.message : e}`);
      break;
    }
    for (const a of auctions) {
      if (considered >= o.limit) break;
      evaluated++;
      const title = a.card_id.slice(0, 8); // resolved via catalog after pricing
      if (a.seller_id === me) {
        bump("mine");
        continue;
      }
      if (a.current_bidder_id === me) {
        bump("leading");
        continue;
      }
      const endsIn = new Date(a.end_at).getTime() - Date.now();
      if (!Number.isFinite(endsIn) || endsIn < o.minSecs * 1000) {
        bump("ending");
        continue;
      }
      const next = minNextBid(a.current_bid, a.base_amount);
      if (next > o.maxPrice) {
        // Next bid already exceeds the per-auction cap — no need to price it.
        bump("overcap");
        continue;
      }
      considered++;
      survivors.push({ a, title, next, endsIn });
    }
    if (!hasMore) break;
  }
  // Phase 2: price survivors from one bulk settled-sales read, decide in scan order.
  // With frozen `only` decisions (Telegram confirm), revalidate each instead.
  let priced: BidDecision[];
  if (only) {
    priced = [];
    let first = true;
    for (const d of only) {
      if (!first) await humanDelay(300, 900); // paced revalidation
      first = false;
      try {
        const a = await getAuctionRow(s, d.id);
        if (!a || a.status !== "active" || a.current_bidder_id === me) {
          bump("ending");
          continue;
        }
        const next = minNextBid(a.current_bid, a.base_amount);
        if (next !== d.next || next > d.cap) {
          bump("overcap"); // price moved since preview
          continue;
        }
        priced.push(d);
      } catch {
        bump("noavg");
      }
    }
  } else {
    // Bulk pricing via direct `auctions` reads (settled_sold). No API fallback:
    // survivors with no settled sales are skipped (`noavg`).
    priced = [];
    let rows: Awaited<ReturnType<typeof getSettledSales>> = [];
    try {
      rows = await getSettledSales(s, [...new Set(survivors.map((sv) => sv.a.card_id))]);
    } catch (e) {
      log(`sales pricing failed, skipping bids: ${e instanceof Error ? e.message : e}`);
    }
    for (const sv of survivors) {
      const avg = statsForSales(rows, sv.a.card_id, sv.a.snapshot_rarity, sv.a.is_shiny)?.average;
      if (avg == null) {
        bump("noavg");
        continue;
      }
      const cap = Math.min(avg * o.factor, o.maxPrice);
      if (sv.next > cap) {
        bump("overcap");
        continue;
      }
      priced.push({ title: sv.title, next: sv.next, endsIn: sv.endsIn, avg, cap, id: sv.a.id });
    }
  }
  if (!only && priced.length > 0) {
    // Resolve display titles for priced candidates (direct rows carry no card join).
    const cardOf = new Map(survivors.map((sv) => [sv.a.id, sv.a.card_id] as const));
    const ids = [...new Set(priced.map((p) => cardOf.get(p.id)).filter((v): v is string => typeof v === "string"))];
    if (ids.length > 0) {
      const titles = new Map(
        (await getPublicCards(s, ids).catch(() => [])).map((r) => [r.id, r.wikipedia_title] as const),
      );
      for (const p of priced) {
        const t = titles.get(cardOf.get(p.id) ?? "");
        if (t) p.title = t;
      }
    }
  }
  for (const p of priced) {
    if (spend.spent + p.next > o.maxTotal) {
      log(`cap reached (${spend.spent}/${o.maxTotal}), stopping`);
      break;
    }
    if (!o.yes) {
      log(`  WOULD BID ${p.title} ${p.next} WB (avg=${p.avg} cap=${p.cap.toFixed(1)} ends in ${Math.round(p.endsIn / 1000)}s)`);
      continue;
    }
    await humanDelay(400, 1200); // humans don't click instantly after scanning
    const res = await placeBid(s, p.id, { amount: p.next });
    if (isDryRun()) {
      log(`  [dry-run] would bid ${p.title} ${p.next} WB (not sent)`);
      continue;
    }
    if (res?.auction) {
      spend.spent += p.next;
      bids++;
      log(`  BID ${p.title} ${p.next} WB (avg=${p.avg})`);
      await Bun.write(BID_SPEND_FILE, JSON.stringify(spend));
    } else {
      log(`  bid ${p.title} returned no auction — stopping`);
      break;
    }
  }
  log(`bid done: ${bids} placed, ${evaluated} evaluated, daily ${spend.spent}/${o.maxTotal}${o.yes ? "" : " (preview)"} skips=${JSON.stringify(skip)}`);
  return priced;
}

/**
 * Collect finished wins: settles everything in the `won` bucket so cards and
 * funds actually transfer. Nothing to decide, nothing to spend — running the
 * command (or the loop) is the opt-in. Honors --dry-run (logs, sends nothing).
 */
export async function cmdSettle(): Promise<number> {
  const s = await ensureSession();
  const { won } = await getMyMarketBuckets(s);
  if (won.length === 0) return 0;
  const titles = new Map(
    (await getPublicCards(s, [...new Set(won.map((a) => a.card_id))]).catch(() => [])).map((r) => [
      r.id,
      r.wikipedia_title,
    ]),
  );
  let settled = 0;
  let firstSettle = true;
  for (const a of won) {
    const title = titles.get(a.card_id) ?? a.card_id.slice(0, 8);
    if (!firstSettle) await humanDelay(500, 1500); // paced writes
    firstSettle = false;
    try {
      await settleAuction(s, a.id);
      if (isDryRun()) {
        log(`  [dry-run] would settle ${title} (final=${a.final_price ?? "?"})`);
        continue;
      }
      settled++;
      log(`  settled ${title} (final=${a.final_price ?? "?"})`);
    } catch (e) {
      log(`  settle ${title} failed: ${e instanceof Error ? e.message : e}`);
    }
  }
  return settled;
}
