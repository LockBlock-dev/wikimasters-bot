// Collection commands: recycle (discard commons), wishlist-clean.
import { isDryRun } from "../config.ts";
import { ensureSession } from "../session.ts";
import { bulkDiscardCards, getProfile } from "../api.ts";
import { log } from "../core.ts";
import { humanDelay } from "../stealth.ts";
import { getMyCollectionDirect, getPublicCards, getWishlistCardIds, removeFromWishlist } from "../supabase.ts";

/**
 * @dangerous Discard every unstarred C-rarity card (+1 wikibidou each).
 * IRREVERSIBLE. Without --yes it only previews. Starred cards are never touched.
 */
export async function cmdRecycle(confirmed: boolean, limit: number, onlyIds?: string[]): Promise<string[]> {
  const s = await ensureSession();
  let ids: string[];
  if (onlyIds) {
    ids = onlyIds;
  } else {
    // Own collection via direct reads (no /api paging).
    const all = await getMyCollectionDirect(s);
    const targets = all.filter((it) => (it.card.rarity ?? "").toUpperCase() === "C" && !it.starred);
    const byTitle = new Map<string, number>();
    for (const t of targets) byTitle.set(t.card.wikipedia_title, (byTitle.get(t.card.wikipedia_title) ?? 0) + (t.count ?? 1));
    log(`${targets.length} unstarred C copies (${byTitle.size} distinct titles, ~+${targets.length} WB)`);
    // Compact preview: top 10 titles max — full per-card dumps blow up chat replies.
    for (const [title, n] of [...byTitle.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) log(`  - ${title} x${n}`);
    if (byTitle.size > 10) log(`  ... +${byTitle.size - 10} more titles`);
    ids = targets.slice(0, limit).map((t) => t.id);
    if (targets.length > limit) log(`capped at --limit ${limit} (${targets.length - limit} left for next run)`);
    if (!confirmed) {
      log(`PREVIEW only — re-run with --yes to discard ${ids.length} cards (~+${ids.length} WB). Star any keeper first.`);
      return ids;
    }
  }
  let discarded = 0;
  const failed: string[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    if (i > 0) await humanDelay(800, 2000); // paced: bulk writes spaced out
    const r = await bulkDiscardCards(s, { card_ids: ids.slice(i, i + 50) });
    discarded += r.discarded_count ?? 0;
    failed.push(...(r.failed ?? []));
  }
  if (isDryRun()) {
    log(`[dry-run] would discard ${ids.length} C cards (~+${ids.length} WB). Nothing sent.`);
    return ids;
  }
  const after = await getProfile(s).catch(() => null);
  const start = after?.wikibidous_balance != null ? after.wikibidous_balance - discarded : null;
  log(`recycled ${discarded}/${ids.length} C cards (~+${discarded} WB${start != null ? `, ${start} -> ${after?.wikibidous_balance}` : ""})${failed.length > 0 ? ` failed=${failed.length}` : ""}`);
  return ids;
}

export async function cmdWishlistClean(confirmed: boolean, onlyIds?: string[]): Promise<string[]> {
  const s = await ensureSession();
  let stale: string[];
  let titles = new Map<string, string>();
  if (onlyIds) {
    stale = onlyIds;
  } else {
    const wanted = await getWishlistCardIds(s);
    if (wanted.length === 0) {
      log("wishlist is empty, nothing to clean");
      return [];
    }
    const owned = new Set<string>();
    for (const it of await getMyCollectionDirect(s)) owned.add(it.card_id);
    stale = wanted.filter((id) => owned.has(id));
    log(`wishlist=${wanted.length}, owned=${owned.size}, already-owned wishlisted=${stale.length}`);
    if (stale.length === 0) return [];
    const rows = await getPublicCards(s, stale).catch(() => []);
    titles = new Map(rows.map((r) => [r.id, r.wikipedia_title]));
    for (const id of stale.slice(0, 30)) log(`  - ${titles.get(id) ?? id}`);
    if (stale.length > 30) log(`  ... +${stale.length - 30} more`);
    if (!confirmed) {
      log(`PREVIEW only — re-run with --yes to remove ${stale.length} (reversible, re-add anytime).`);
      return stale;
    }
  }
  let removed = 0;
  let firstRemove = true;
  for (const id of stale) {
    if (isDryRun()) {
      log(`  [dry-run] would remove ${titles.get(id) ?? id} (not sent)`);
      continue;
    }
    if (!firstRemove) await humanDelay(400, 1000); // paced writes
    firstRemove = false;
    await removeFromWishlist(s, id);
    removed++;
  }
  log(isDryRun() ? `[dry-run] would remove ${stale.length}. Nothing sent.` : `removed ${removed}/${stale.length} from wishlist`);
  return stale;
}
