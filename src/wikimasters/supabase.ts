// Direct Supabase access via @supabase/supabase-js (works on Bun).
// The site itself uses this path for tags, stars, wishlist and collection
// reads — there is no /api route for these. Reads use RLS (user-scoped).
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL, isDryRun } from "../config.ts";
import { SUPABASE_CLIENT_INFO, humanDelay, supabaseHeaders } from "./stealth.ts";
import type {
  Achievement,
  Auction,
  AuctionBid,
  ChatMessage,
  CollectionItem,
  NotificationItem,
  Tag,
  TagCreateResult,
  Trade,
  UserAchievement,
  UserCardRow,
  WikiSession,
} from "./types.ts";

/** Client bound to the bot session (per-call: picks up refreshed tokens). */
export function supabaseFor(session: WikiSession): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: {
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        // Blend with the site's own browser client (cf. src/wikimasters/stealth.ts).
        "X-Client-Info": SUPABASE_CLIENT_INFO,
        ...supabaseHeaders(),
      },
    },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function throwOnError(error: { message: string } | null, what: string): void {
  if (error) throw new Error(`supabase ${what}: ${error.message}`);
}

/** Loud when a capped read hits its cap — silent truncation hides data. */
function warnIfTruncated(what: string, got: number, limit: number): void {
  if (got >= limit) console.warn(`[supabase] ${what}: hit limit ${limit}, results truncated`);
}

/** Supabase RPC with retries (direct REST is flaky: intermittent 525 from Cloudflare). */
export async function supabaseRpc<T>(
  session: WikiSession,
  fn: "sync_profile_packs" | "get_my_profile" | "delete_tag",
  params: Record<string, unknown>,
): Promise<T> {
  let lastErr = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
        method: "POST",
        headers: {
          apikey: SUPABASE_ANON_KEY,
          authorization: `Bearer ${session.access_token}`,
          "content-profile": "public",
          "content-type": "application/json",
          "x-client-info": SUPABASE_CLIENT_INFO,
          ...supabaseHeaders(),
        },
        body: JSON.stringify(params),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`rpc ${fn} ${res.status}: ${text.slice(0, 300)}`);
      const data = JSON.parse(text);
      return (Array.isArray(data) ? data[0] : data) as T;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      await humanDelay(1000 * 2 ** attempt, 1000 * 2 ** attempt + 800);
    }
  }
  throw new Error(`rpc ${fn} failed after retries: ${lastErr}`);
}

// --- Tags ---------------------------------------------------------------------

export async function getTags(session: WikiSession): Promise<Tag[]> {
  const sb = supabaseFor(session);
  const { data, error } = await sb.from("tags").select("*").eq("user_id", session.user.id);
  throwOnError(error, "getTags");
  return (data ?? []) as Tag[];
}

export async function createTag(session: WikiSession, name: string, color: string): Promise<TagCreateResult> {
  if (isDryRun()) {
    console.log(`[dry-run] supabase tags.insert {name: ${name}} (not sent)`);
    return { tag: { id: "dry-run", user_id: session.user.id, name, color } as Tag, created: true };
  }
  const sb = supabaseFor(session);
  const { data, error } = await sb
    .from("tags")
    .insert({ user_id: session.user.id, name, color })
    .select("*")
    .single();
  if (error && (error as { code?: string }).code === "23505") {
    // Duplicate name: return the existing tag (mirrors the site).
    const tags = await getTags(session);
    const existing = tags.find((t) => t.name.trim().toLowerCase() === name.trim().toLowerCase());
    if (!existing) throw new Error("supabase createTag: duplicate but existing tag not found");
    return { tag: existing, created: false };
  }
  throwOnError(error, "createTag");
  return { tag: data as Tag, created: true };
}

export async function setTagColor(session: WikiSession, tagId: string, color: string): Promise<void> {
  if (isDryRun()) {
    console.log(`[dry-run] supabase tags.update {id: ${tagId}, color} (not sent)`);
    return;
  }
  const sb = supabaseFor(session);
  const { error } = await sb.from("tags").update({ color }).eq("id", tagId);
  throwOnError(error, "setTagColor");
}

/** Rename a tag (site: tags.update({name}), 23505 = duplicate name). */
export async function renameTag(session: WikiSession, tagId: string, name: string): Promise<void> {
  if (isDryRun()) {
    console.log(`[dry-run] supabase tags.update {id: ${tagId}, name: ${name}} (not sent)`);
    return;
  }
  const sb = supabaseFor(session);
  const { error } = await sb.from("tags").update({ name }).eq("id", tagId);
  if (error && (error as { code?: string }).code === "23505") {
    throw new Error("supabase renameTag: a tag with this name already exists");
  }
  throwOnError(error, "renameTag");
}

/** Delete a tag and its card links (site: rpc delete_tag {p_tag_id}). */
export async function deleteTag(session: WikiSession, tagId: string): Promise<void> {
  if (isDryRun()) {
    console.log(`[dry-run] supabase rpc delete_tag {id: ${tagId}} (not sent)`);
    return;
  }
  const sb = supabaseFor(session);
  const { error } = await sb.rpc("delete_tag", { p_tag_id: tagId });
  throwOnError(error, "deleteTag");
}

// --- Achievements (read-only, mirrors the site's achievements page) -------------

/** Full achievement catalog (read-only). */
export async function getAchievements(session: WikiSession): Promise<Achievement[]> {
  const sb = supabaseFor(session);
  const { data, error } = await sb.from("achievements").select("*");
  throwOnError(error, "getAchievements");
  return (data ?? []) as Achievement[];
}

/** The bot owner's unlock/claim state (read-only). */
export async function getMyAchievements(session: WikiSession): Promise<UserAchievement[]> {
  const sb = supabaseFor(session);
  const { data, error } = await sb.from("user_achievements").select("*").eq("user_id", session.user.id);
  throwOnError(error, "getMyAchievements");
  return (data ?? []) as UserAchievement[];
}

/** The bot owner's notifications, newest first (replaces GET /api/notifications). */
export async function getMyNotifications(session: WikiSession, limit = 100): Promise<NotificationItem[]> {
  const sb = supabaseFor(session);
  const { data, error } = await sb
    .from("notifications")
    .select("*")
    .eq("user_id", session.user.id)
    .order("created_at", { ascending: false })
    .limit(limit);
  throwOnError(error, "getMyNotifications");
  warnIfTruncated("getMyNotifications", data?.length ?? 0, limit);
  return (data ?? []) as NotificationItem[];
}

/** The bot owner's trades, newest first (replaces GET /api/trades[?active=1]). */
export async function getMyTrades(session: WikiSession, activeOnly = false, limit = 200): Promise<Trade[]> {
  const sb = supabaseFor(session);
  let q = sb
    .from("trades")
    .select("*")
    .or(`initiator_id.eq.${session.user.id},recipient_id.eq.${session.user.id}`)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (activeOnly) q = q.eq("status", "pending");
  const { data, error } = await q;
  throwOnError(error, "getMyTrades");
  warnIfTruncated("getMyTrades", data?.length ?? 0, limit);
  return (data ?? []) as Trade[];
}

export async function tagCard(session: WikiSession, userCardId: string, tagId: string): Promise<void> {
  if (isDryRun()) {
    console.log(`[dry-run] supabase user_card_tags.insert {card: ${userCardId}, tag: ${tagId}} (not sent)`);
    return;
  }
  const sb = supabaseFor(session);
  const { error } = await sb.from("user_card_tags").insert({ user_card_id: userCardId, tag_id: tagId });
  throwOnError(error, "tagCard");
}

export async function untagCard(session: WikiSession, userCardId: string, tagId: string): Promise<void> {
  if (isDryRun()) {
    console.log(`[dry-run] supabase user_card_tags.delete {card: ${userCardId}, tag: ${tagId}} (not sent)`);
    return;
  }
  const sb = supabaseFor(session);
  const { error } = await sb.from("user_card_tags").delete().eq("user_card_id", userCardId).eq("tag_id", tagId);
  throwOnError(error, "untagCard");
}

// --- Stars / wishlist ------------------------------------------------------------

export async function setStarred(session: WikiSession, userCardId: string, starred: boolean): Promise<void> {
  if (isDryRun()) {
    console.log(`[dry-run] supabase user_cards.update {id: ${userCardId}, starred: ${starred}} (not sent)`);
    return;
  }
  const sb = supabaseFor(session);
  const { error } = await sb.from("user_cards").update({ starred }).eq("id", userCardId);
  throwOnError(error, "setStarred");
}

export async function getUserCardsByCardIds(session: WikiSession, cardIds: string[]): Promise<UserCardRow[]> {
  const sb = supabaseFor(session);
  const { data, error } = await sb
    .from("user_cards")
    .select("id, card_id, starred, is_shiny, user_card_tags(tag:tags(*))")
    .eq("user_id", session.user.id)
    .in("card_id", cardIds);
  throwOnError(error, "getUserCardsByCardIds");
  return (data ?? []) as unknown as UserCardRow[];
}

export async function getWishlistCardIds(session: WikiSession): Promise<string[]> {
  const sb = supabaseFor(session);
  const { data, error } = await sb.from("wishlist_items").select("card_id").eq("user_id", session.user.id);
  throwOnError(error, "getWishlistCardIds");
  return ((data ?? []) as Array<{ card_id: string }>).map((r) => r.card_id);
}

export async function addToWishlist(session: WikiSession, cardId: string): Promise<void> {
  if (isDryRun()) {
    console.log(`[dry-run] supabase wishlist_items.insert {card: ${cardId}} (not sent)`);
    return;
  }
  const sb = supabaseFor(session);
  const { error } = await sb.from("wishlist_items").insert({ user_id: session.user.id, card_id: cardId });
  if (error && (error as { code?: string }).code !== "23505") throw new Error(`supabase addToWishlist: ${error.message}`);
}

export async function removeFromWishlist(session: WikiSession, cardId: string): Promise<void> {
  if (isDryRun()) {
    console.log(`[dry-run] supabase wishlist_items.delete {card: ${cardId}} (not sent)`);
    return;
  }
  const sb = supabaseFor(session);
  const { error } = await sb.from("wishlist_items").delete().eq("user_id", session.user.id).eq("card_id", cardId);
  throwOnError(error, "removeFromWishlist");
}

// --- Market sales history (bulk, direct `auctions` reads) -----------------------
// Replaces per-card `/api/marketplace/cards/:id/sales?scope=summary` calls:
// one PostgREST query per ~10 card ids (80 UUIDs in one URL trips Cloudflare 525,
// see wm/README.md). No API fallback — cards without settled sales are skipped.

export interface AuctionSaleRow {
  card_id: string;
  snapshot_rarity: string | null;
  is_shiny: boolean | null;
  final_price: number;
  settled_at: string | null;
}

export interface SaleStats {
  count: number;
  average: number;
  latest?: number;
  max?: number;
}

function chunkIds(ids: string[], size: number): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

/** Settled sales for the given cards, newest first per batch. */
export async function getSettledSales(session: WikiSession, cardIds: string[]): Promise<AuctionSaleRow[]> {
  const ids = [...new Set(cardIds.filter(Boolean))];
  if (ids.length === 0) return [];
  const sb = supabaseFor(session);
  const rows: AuctionSaleRow[] = [];
  const batches = chunkIds(ids, 10);
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i]!;
    const { data, error } = await sb
      .from("auctions")
      .select("card_id,snapshot_rarity,is_shiny,final_price,settled_at")
      .eq("status", "settled_sold")
      .in("card_id", batch)
      .order("settled_at", { ascending: false })
      .limit(500);
    throwOnError(error, "getSettledSales");
    warnIfTruncated("getSettledSales/batch", data?.length ?? 0, 500);
    rows.push(...((data ?? []) as AuctionSaleRow[]));
    if (i + 1 < batches.length) await humanDelay(150, 500);
  }
  return rows;
}

/**
 * Aggregate settled rows for one card. Prefers the owned
 * rarity/shiny pool, falls back to the wider pool — never to the API.
 */
export function statsForSales(
  rows: AuctionSaleRow[],
  cardId: string,
  rarity?: string | null,
  shiny?: boolean | null,
): SaleStats | undefined {
  let pool = rows.filter((r) => r.card_id === cardId);
  if (pool.length === 0) return undefined;
  if (rarity != null) {
    const byRarity = pool.filter((r) => (r.snapshot_rarity ?? "") === rarity);
    if (byRarity.length > 0) pool = byRarity;
    if (shiny != null) {
      const exact = pool.filter((r) => (r.is_shiny ?? false) === shiny);
      if (exact.length > 0) pool = exact;
    }
  }
  const prices = pool.map((r) => r.final_price).filter((n) => Number.isFinite(n));
  if (prices.length === 0) return undefined;
  let latest: number | undefined;
  let latestAt = -Infinity;
  for (const r of pool) {
    const t = r.settled_at ? Date.parse(r.settled_at) : NaN;
    if (Number.isFinite(t) && t > latestAt) {
      latestAt = t;
      latest = r.final_price;
    }
  }
  const sum = prices.reduce((a, b) => a + b, 0);
  return { count: prices.length, average: sum / prices.length, latest, max: Math.max(...prices) };
}

// --- Public card catalog (read-only, used by the battle room) ------------------

export interface PublicCardRow {
  id: string;
  wikipedia_title: string;
  wikipedia_url?: string;
  image_url?: string | null;
  hide_image?: boolean;
  category?: string | null;
  q_score?: number;
  rarity?: string;
  atk?: number;
  def?: number;
  pageviews?: number;
  lang?: string;
  created_at?: string;
}

export async function getPublicCards(session: WikiSession, cardIds: string[]): Promise<PublicCardRow[]> {
  const sb = supabaseFor(session);
  const { data, error } = await sb
    .from("cards")
    .select("id, wikipedia_title, wikipedia_url, image_url, hide_image, category, q_score, rarity, atk, def, pageviews, lang, created_at")
    .in("id", cardIds);
  throwOnError(error, "getPublicCards");
  return (data ?? []) as PublicCardRow[];
}

// --- Own collection, rebuilt from direct reads (replaces /api/my-collection) ---
// user_cards (own rows) + cards (public), merged with the site's
// effectiveCardListItem rule: snapshot_* wins over the base card row.

export async function getMyCollectionDirect(session: WikiSession): Promise<CollectionItem[]> {
  const sb = supabaseFor(session);
  const owned: Array<Record<string, unknown>> = [];
  for (let offset = 0; ; offset += 500) {
    if (offset > 0) await humanDelay(400, 1100);
    const { data, error } = await sb
      .from("user_cards")
      .select("*")
      .eq("user_id", session.user.id)
      .order("obtained_at", { ascending: true })
      .range(offset, offset + 499);
    throwOnError(error, "getMyCollectionDirect");
    const page = (data ?? []) as Array<Record<string, unknown>>;
    owned.push(...page);
    if (page.length < 500) break;
  }
  const cardIds = [...new Set(owned.map((r) => r["card_id"]).filter((v): v is string => typeof v === "string"))];
  const cards = new Map<string, PublicCardRow>();
  for (const batch of chunkIds(cardIds, 10)) {
    const rows = await getPublicCards(session, batch);
    for (const c of rows) cards.set(c.id, c);
    if (cardIds.length > 10) await humanDelay(150, 500);
  }
  return owned.flatMap((r) => {
    const cardId = r["card_id"];
    if (typeof cardId !== "string") return [];
    const c = cards.get(cardId);
    if (!c) return [];
    const card = {
      id: c.id,
      wikipedia_title: c.wikipedia_title,
      wikipedia_url: c.wikipedia_url,
      image_url: c.image_url,
      hide_image: c.hide_image,
      category: c.category,
      q_score: c.q_score,
      rarity: (r["snapshot_rarity"] as string | null) ?? c.rarity ?? "",
      atk: (r["snapshot_atk"] as number | null) ?? c.atk ?? 0,
      def: (r["snapshot_def"] as number | null) ?? c.def ?? 0,
      pageviews: c.pageviews ?? 0,
      lang: c.lang,
      is_shiny: r["is_shiny"] === true,
    };
    return [
      {
        id: r["id"],
        user_id: session.user.id,
        card_id: cardId,
        count: (r["count"] as number | null) ?? 1,
        starred: r["starred"] === true,
        obtained_at: r["obtained_at"],
        is_shiny: r["is_shiny"] === true,
        snapshot_rarity: r["snapshot_rarity"],
        snapshot_atk: r["snapshot_atk"],
        snapshot_def: r["snapshot_def"],
        card,
      } as unknown as CollectionItem,
    ];
  });
}

// --- Bulk tag ops (mirror the site's tag modal, 14yi4kchm5v2m.js) ----------------

export interface TagApplyResult {
  added: number;
  skipped: number;
}

/** Apply one tag to many cards (upsert, duplicates skipped). */
export async function applyTagToCards(
  session: WikiSession,
  userCardIds: string[],
  tagId: string,
): Promise<TagApplyResult> {
  if (isDryRun()) {
    console.log(`[dry-run] supabase user_card_tags.upsert {tag: ${tagId}, cards: ${userCardIds.length}} (not sent)`);
    return { added: 0, skipped: userCardIds.length };
  }
  const sb = supabaseFor(session);
  const { error, count } = await sb
    .from("user_card_tags")
    .upsert(userCardIds.map((user_card_id) => ({ user_card_id, tag_id: tagId })), {
      onConflict: "user_card_id,tag_id",
      ignoreDuplicates: true,
      count: "exact",
    });
  throwOnError(error, "applyTagToCards");
  const added = count ?? 0;
  return { added, skipped: userCardIds.length - added };
}

/** Remove one tag from many cards (deleted in 100-slices, like the site). */
export async function removeTagFromCards(
  session: WikiSession,
  userCardIds: string[],
  tagId: string,
): Promise<number> {
  if (isDryRun()) {
    console.log(`[dry-run] supabase user_card_tags.delete {tag: ${tagId}, cards: ${userCardIds.length}} (not sent)`);
    return 0;
  }
  const sb = supabaseFor(session);
  let removed = 0;
  for (const slice of chunkIds(userCardIds, 100)) {
    const { error, count } = await sb
      .from("user_card_tags")
      .delete({ count: "exact" })
      .eq("tag_id", tagId)
      .in("user_card_id", slice);
    throwOnError(error, "removeTagFromCards");
    removed += count ?? 0;
  }
  return removed;
}

/** user_card ids carrying ANY tag, looked up in 100-slices. */
export async function getTaggedUserCardIds(
  session: WikiSession,
  userCardIds: string[],
): Promise<Set<string>> {
  const sb = supabaseFor(session);
  const out = new Set<string>();
  for (const slice of chunkIds(userCardIds, 100)) {
    if (slice.length === 0) continue;
    const { data, error } = await sb.from("user_card_tags").select("user_card_id").in("user_card_id", slice);
    throwOnError(error, "getTaggedUserCardIds");
    for (const r of (data ?? []) as Array<{ user_card_id: string }>) out.add(r.user_card_id);
  }
  return out;
}

/** user_card ids carrying a tag, looked up in 100-slices (site pattern). */
export async function getTagCardIds(
  session: WikiSession,
  tagId: string,
  userCardIds: string[],
): Promise<string[]> {
  const sb = supabaseFor(session);
  const out: string[] = [];
  for (const slice of chunkIds(userCardIds, 100)) {
    const { data, error } = await sb
      .from("user_card_tags")
      .select("user_card_id")
      .eq("tag_id", tagId)
      .in("user_card_id", slice);
    throwOnError(error, "getTagCardIds");
    for (const r of (data ?? []) as Array<{ user_card_id: string }>) out.push(r.user_card_id);
  }
  return out;
}

// --- Chat history (replaces GET /api/chat[/:peer]) -------------------------------
// Table + columns proven live: id, sender_id, recipient_id, content, read,
// created_at. Sending stays on POST /api/chat/:peer (no direct insert seen).

export type ChatMessageRow = ChatMessage & { recipient_id: string };

/** Full DM history with one peer, oldest first. */
export async function getChatHistory(
  session: WikiSession,
  peerId: string,
  limit = 100,
): Promise<ChatMessageRow[]> {
  const me = session.user.id;
  const sb = supabaseFor(session);
  const { data, error } = await sb
    .from("chat_messages")
    .select("*")
    .or(`and(sender_id.eq.${me},recipient_id.eq.${peerId}),and(sender_id.eq.${peerId},recipient_id.eq.${me})`)
    .order("created_at", { ascending: true })
    .limit(limit);
  throwOnError(error, "getChatHistory");
  return (data ?? []) as ChatMessageRow[];
}

/** Mark one incoming message read (site does this on realtime receipt). */
export async function markChatMessageRead(session: WikiSession, messageId: string): Promise<void> {
  if (isDryRun()) {
    console.log(`[dry-run] supabase chat_messages.update {id: ${messageId}, read: true} (not sent)`);
    return;
  }
  const sb = supabaseFor(session);
  const { error } = await sb.from("chat_messages").update({ read: true }).eq("id", messageId);
  throwOnError(error, "markChatMessageRead");
}

// --- Own market buckets (replaces the browse mine=1 buckets for reads) -----------
// Filters verified live one-to-one against /api/marketplace?mine=1
// (selling/bidding/won = 3/3/3, history empty both ways).

export interface MarketBuckets {
  selling: Auction[];
  bidding: Auction[];
  won: Auction[];
  history: Auction[];
}

/** selling/bidding/won/history in 4 filtered reads (full auction rows). */
export async function getMyMarketBuckets(session: WikiSession): Promise<MarketBuckets> {
  const me = session.user.id;
  const sb = supabaseFor(session);
  const run = async (label: string, params: Record<string, string>, order: string, limit: number): Promise<Auction[]> => {
    let q = sb.from("auctions").select("*");
    for (const [k, v] of Object.entries(params)) q = q.eq(k, v);
    const [col, dir] = order.startsWith("-") ? [order.slice(1), false] : [order, true];
    const { data, error } = await q.order(col, { ascending: dir }).limit(limit);
    throwOnError(error, "getMyMarketBuckets");
    warnIfTruncated(`getMyMarketBuckets/${label}`, data?.length ?? 0, limit);
    return (data ?? []) as Auction[];
  };
  const selling = await run("selling", { seller_id: me, status: "active" }, "end_at", 200);
  await humanDelay(150, 500);
  const bidding = await run("bidding", { current_bidder_id: me, status: "active" }, "end_at", 200);
  await humanDelay(150, 500);
  const won = await run("won", { winner_id: me }, "-settled_at", 200);
  await humanDelay(150, 500);
  const history = await run("history", { seller_id: me, status: "settled_sold" }, "-settled_at", 200);
  return { selling, bidding, won, history };
}

/**
 * Bid history for one auction. RLS shows own/visible bids only
 * (unfiltered select returns []).
 */
export async function getAuctionBids(session: WikiSession, auctionId: string, limit = 100): Promise<AuctionBid[]> {
  const sb = supabaseFor(session);
  const { data, error } = await sb
    .from("auction_bids")
    .select("*")
    .eq("auction_id", auctionId)
    .order("created_at", { ascending: false })
    .limit(limit);
  throwOnError(error, "getAuctionBids");
  warnIfTruncated("getAuctionBids", data?.length ?? 0, limit);
  return (data ?? []) as AuctionBid[];
}

// --- Direct marketplace browse (replaces GET /api/marketplace for scans) -------
// status=eq.active + server-sort parity (recent = created_at desc,
// ending_soon = end_at asc) + seller-username embed (FK-hint verified live).

export interface BrowseAuctionsParams {
  sort?: "recent" | "ending_soon";
  limit?: number;
  page?: number; // 0-indexed window over limit-sized ranges
}

export async function browseAuctionsDirect(
  session: WikiSession,
  params: BrowseAuctionsParams = {},
): Promise<{ auctions: Auction[]; hasMore: boolean }> {
  const limit = params.limit ?? 25;
  const page = params.page ?? 0;
  const sb = supabaseFor(session);
  const { data, error } = await sb
    .from("auctions")
    .select("*,seller:profiles!auctions_seller_id_fkey(username)")
    .eq("status", "active")
    .order(params.sort === "ending_soon" ? "end_at" : "created_at", {
      ascending: params.sort === "ending_soon",
    })
    .range(page * limit, page * limit + limit - 1);
  throwOnError(error, "browseAuctionsDirect");
  const auctions = (data ?? []) as unknown as Auction[];
  return { auctions, hasMore: auctions.length === limit };
}

/** One auction row by id (for bid revalidation — no detail endpoint needed). */
export async function getAuctionRow(session: WikiSession, auctionId: string): Promise<Auction | null> {
  const sb = supabaseFor(session);
  const { data, error } = await sb.from("auctions").select("*").eq("id", auctionId).limit(1);
  throwOnError(error, "getAuctionRow");
  const rows = (data ?? []) as unknown as Auction[];
  return rows[0] ?? null;
}

// --- Card search (replaces GET /api/cards?q=) ------------------------------------
// `cards` is fully public; ilike search proven live.

export async function searchPublicCards(session: WikiSession, query: string, limit = 20): Promise<PublicCardRow[]> {
  const q = query.replace(/[%*,()\\]/g, "").trim();
  if (!q) return [];
  const sb = supabaseFor(session);
  const { data, error } = await sb
    .from("cards")
    .select("id, wikipedia_title, wikipedia_url, image_url, hide_image, category, q_score, rarity, atk, def, pageviews, lang, created_at")
    .ilike("wikipedia_title", `*${q}*`)
    .limit(limit);
  throwOnError(error, "searchPublicCards");
  return (data ?? []) as PublicCardRow[];
}

// --- Battle head-to-head (mirrors the battle-page query, 16--2uzzsq.94.js) -------

export interface HeadToHead {
  winsA: number;
  winsB: number;
  total: number;
}

/** Completed-game record between two users, from A's perspective. */
export async function getHeadToHead(session: WikiSession, userA: string, userB: string): Promise<HeadToHead> {
  const sb = supabaseFor(session);
  const { data, error } = await sb
    .from("battles")
    .select("winner_id")
    .eq("status", "completed")
    .or(`and(challenger_id.eq.${userA},opponent_id.eq.${userB}),and(challenger_id.eq.${userB},opponent_id.eq.${userA})`);
  throwOnError(error, "getHeadToHead");
  let winsA = 0;
  let winsB = 0;
  for (const r of (data ?? []) as Array<{ winner_id: string | null }>) {
    if (r.winner_id === userA) winsA++;
    else if (r.winner_id === userB) winsB++;
  }
  return { winsA, winsB, total: winsA + winsB };
}

// --- Narrow profile reads (per-column grants, no select=*) -----------------------

export interface MiniProfile {
  id: string;
  username?: string;
  is_pro?: boolean;
  is_admin?: boolean;
}

/** Other users' visible columns (username needs an authed session). */
export async function getMiniProfile(session: WikiSession, userId: string): Promise<MiniProfile | null> {
  const sb = supabaseFor(session);
  const { data, error } = await sb.from("profiles").select("id,username,is_pro,is_admin").eq("id", userId).single();
  throwOnError(error, "getMiniProfile");
  return data as MiniProfile | null;
}
