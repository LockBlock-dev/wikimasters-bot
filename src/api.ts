import { SITE_URL, isDryRun } from "./config.ts";
import { browserHeaders } from "./stealth.ts";
import { supabaseRpc } from "./supabase.ts";
import { buildWikiCookie } from "./session.ts";
import type {
  AchievementClaimResult,
  ApiErrorData,
  AppealInput,
  AuctionDetail,
  BattleActionInput,
  BattleDetail,
  BattleList,
  BattleTurnResult,
  BillingPortalResult,
  BulkDiscardInput,
  BulkDiscardResult,
  CardCatalogParams,
  CardCatalogResult,
  CardSalesHistory,
  CardSalesSummary,
  CardWebResult,
  CheckoutInput,
  CheckoutResult,
  ClearShowcaseInput,
  CollectionStats,
  ConversationDetail,
  ConversationList,
  CreatedDuel,
  CreateGuildInput,
  CreateListingInput,
  CreateListingResult,
  CreateTradeInput,
  CreateTradeResult,
  CreatedBattle,
  CreatedParty,
  DiscardResult,
  DonateCardInput,
  DuelList,
  ExistingReport,
  FriendAction,
  FriendList,
  Friendship,
  GuildChat,
  GuildChatMessage,
  GuildHome,
  GuildLeaderboard,
  GuildMemberIds,
  GuildMemberList,
  GuildMutationResult,
  GuildWishlistItem,
  HumanVerifyResult,
  IapVerifyInput,
  ImageReportsMine,
  LogSecurityEventInput,
  MarketplaceBrowseParams,
  MarketplaceBrowseResult,
  MarketplaceMine,
  MyCollectionParams,
  MyCollectionResult,
  NotificationList,
  OpenPackErrorData,
  OpenPackResult,
  PartyQuota,
  PlaceBidInput,
  PlaceBidResult,
  PostConfirmationInput,
  ProDailyStatus,
  ClaimPackResult,
  Profile,
  PushSubscriptionPayload,
  RenameGalleryInput,
  RepriceInput,
  RepriceResult,
  ReportInput,
  SentChatMessage,
  SetShowcaseInput,
  SettleResult,
  ShowcaseResult,
  SpecialPacksResult,
  Trade,
  TradeAction,
  TradeList,
  UpdateGuildInput,
  UpdateProfileInput,
  UpdatedProfile,
  UserSearchResult,
  UsernameAvailability,
  WikibidousBalance,
  WikiSession,
  ZeventStandings,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Authenticated wiki API calls (cookie session). No blocklist, no opt-ins:
// every function here calls straight through. Mutating functions are still
// tagged @dangerous in their docs so you know what spends assets.
// Direct Supabase access (RPC included) lives in ./supabase.ts.
// ---------------------------------------------------------------------------

export async function getProfile(session: WikiSession): Promise<Profile> {
  return supabaseRpc<Profile>(session, "sync_profile_packs", { user_id: session.user.id });
}

function cookieHeaders(session: WikiSession): Record<string, string> {
  return {
    Cookie: buildWikiCookie(session),
    ...browserHeaders(),
  };
}

/** Authenticated wiki API call (cookie session). */
export async function wikiFetch(session: WikiSession, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${SITE_URL}${path}`, {
    ...init,
    headers: { ...cookieHeaders(session), ...(init.headers as Record<string, string> | undefined) },
  });
}

async function wikiJson<T>(session: WikiSession, path: string, init: RequestInit = {}): Promise<T> {
  const res = await wikiFetch(session, path, init);
  const text = await res.text();
  if (!res.ok) {
    const data = safeParse<ApiErrorData>(text);
    throw new Error(`${path} -> ${res.status}: ${data?.error ?? text.slice(0, 300)}`);
  }
  return JSON.parse(text) as T;
}

function safeParse<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/**
 * Mutating-call wrapper with dry-run support. When `--dry-run` / `DRY_RUN=1`
 * is set, logs the request and returns an empty stub instead of sending it.
 * Read-only helpers and free pack open/claim calls use wikiJson directly and
 * are never blocked.
 */
async function wikiMutate<T>(session: WikiSession, path: string, init: RequestInit = {}): Promise<T> {
  if (isDryRun()) {
    const body = typeof init.body === "string" ? init.body.slice(0, 300) : "";
    console.log(`[dry-run] ${init.method ?? "GET"} ${path}${body ? ` ${body}` : ""} (not sent)`);
    return {} as T;
  }
  return wikiJson<T>(session, path, init);
}

/** Honeypot human check. Body must stay {"website":""} (empty = human). */
export async function verifyHuman(session: WikiSession): Promise<HumanVerifyResult> {
  return wikiJson<HumanVerifyResult>(session, "/api/packs/verify-human", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ website: "" }),
  });
}

export async function openPack(session: WikiSession): Promise<OpenPackResult> {
  const res = await wikiFetch(session, "/api/packs/open", { method: "POST" });
  const text = await res.text();
  const data = safeParse<OpenPackResult>(text);
  if (!data) throw new Error(`/api/packs/open -> ${res.status}: ${text.slice(0, 300)}`);
  if (!res.ok) {
    const err = new Error(data.error ?? `open failed: ${res.status}`) as Error & { data: OpenPackErrorData; status: number };
    err.data = data;
    err.status = res.status;
    throw err;
  }
  return data;
}

// --- Read-only helpers ------------------------------------------------------

export async function getNotifications(session: WikiSession): Promise<NotificationList> {
  return wikiJson<NotificationList>(session, "/api/notifications");
}

/** Mark notifications read (site: PATCH /api/notifications {ids}). No spend. */
export async function markNotificationsRead(session: WikiSession, ids: string[]): Promise<unknown> {
  return wikiJson<unknown>(session, "/api/notifications", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids }),
  });
}

/** Mark all notifications read (site: PATCH /api/notifications {}). No spend. */
export async function markAllNotificationsRead(session: WikiSession): Promise<unknown> {
  return wikiJson<unknown>(session, "/api/notifications", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
}

export async function getActiveTrades(session: WikiSession): Promise<TradeList> {
  return wikiJson<TradeList>(session, "/api/trades?active=1");
}

export async function getMarketplaceMine(session: WikiSession): Promise<MarketplaceMine> {
  // NOTE: GET /api/marketplace/mine returns counts only ({sellingCount,
  // maxConcurrentAuctions}). The selling/bidding/won/history buckets live on
  // browse with mine=1 (verified live: selling/bidding/won = 3/3/3, matching
  // direct `auctions` seller/bidder/winner filters one-to-one).
  const r = await browseMarketplace(session, { mine: true, limit: 1, page: 1 });
  return {
    selling: r.selling ?? [],
    bidding: r.bidding ?? [],
    won: r.won ?? [],
    history: r.history ?? [],
    sellingCount: r.selling?.length ?? null,
    maxConcurrentAuctions: r.maxConcurrentAuctions,
  };
}

export async function getSpecialPacks(session: WikiSession): Promise<SpecialPacksResult> {
  return wikiJson<SpecialPacksResult>(session, "/api/packs/special");
}

export async function getProDailyStatus(session: WikiSession): Promise<ProDailyStatus> {
  return wikiJson<ProDailyStatus>(session, "/api/packs/pro-daily");
}

/** Free PRO daily pack claim. Safe (no spend). 403 when account is not PRO. */
export async function claimProDaily(session: WikiSession): Promise<ClaimPackResult> {
  return wikiJson<ClaimPackResult>(session, "/api/packs/pro-daily", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
}

/** Free special-pack claim. Safe (no spend). 404 when no event is active. */
export async function claimSpecialPack(session: WikiSession, packId?: string): Promise<ClaimPackResult> {
  return wikiJson<ClaimPackResult>(session, "/api/packs/special", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // Site sends {packId} (camelCase) — verified from the pulls-page chunk.
    body: JSON.stringify(packId ? { packId } : {}),
  });
}

/**
 * Free VIP grace-pack claim. Safe (no spend). 403 when account is not VIP.
 * NOTE: GET /api/packs/grace returns 405; the claim is POST-only.
 */
export async function claimGracePack(session: WikiSession): Promise<ClaimPackResult> {
  return wikiJson<ClaimPackResult>(session, "/api/packs/grace", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
}

export async function getWikibidousBalance(session: WikiSession): Promise<WikibidousBalance> {
  return wikiJson<WikibidousBalance>(session, "/api/wikibidous");
}

export async function getCollectionStats(session: WikiSession): Promise<CollectionStats> {
  return wikiJson<CollectionStats>(session, "/api/my-collection/stats?sort=rarity");
}

/** Browse active auctions (read-only). */
export async function browseMarketplace(session: WikiSession, params: MarketplaceBrowseParams = {}): Promise<MarketplaceBrowseResult> {
  const q = new URLSearchParams();
  if (params.page) q.set("page", String(params.page));
  if (params.limit) q.set("limit", String(params.limit));
  if (params.search) q.set("search", params.search);
  if (params.sort) q.set("sort", params.sort);
  if (params.mine) q.set("mine", "1");
  for (const r of params.rarities ?? []) q.append("rarity", r);
  const qs = q.toString();
  return wikiJson<MarketplaceBrowseResult>(session, `/api/marketplace${qs ? `?${qs}` : ""}`);
}

/** Full auction detail + bid history (read-only). */
export async function getAuctionDetail(session: WikiSession, auctionId: string): Promise<AuctionDetail> {
  return wikiJson<AuctionDetail>(session, `/api/marketplace/${auctionId}`);
}

/**
 * Average market value for a card: per-rarity { count, latest, average }
 * over past sales. Read-only.
 */
export async function getCardMarketSummary(session: WikiSession, cardId: string): Promise<CardSalesSummary> {
  return wikiJson<CardSalesSummary>(session, `/api/marketplace/cards/${cardId}/sales?scope=summary`);
}

/** Full past-sales history for a card (read-only). */
export async function getCardSalesHistory(session: WikiSession, cardId: string): Promise<CardSalesHistory> {
  return wikiJson<CardSalesHistory>(session, `/api/marketplace/cards/${cardId}/sales`);
}

export function needsHumanVerify(p: Profile, now = Date.now()): boolean {
  if (!p.pack_human_verified_at) return true;
  const t = new Date(p.pack_human_verified_at).getTime();
  if (!Number.isFinite(t)) return true;
  return now - t >= 432e5; // 12 h, mirrors web client
}

/** Site rule: minimum next bid = max(ceil(1.1 * current), current + 1). */
export function minNextBid(current: number | null, baseAmount: number): number {
  const e = current ?? baseAmount;
  return Math.max(Math.ceil(1.1 * e), e + 1);
}

// --- @dangerous: these mutate assets. Not wired to the CLI. -----------------

/**
 * @dangerous List a card for auction (SELL). Moves the card out of the
 * collection into escrow until sold/unsold/cancelled.
 * Site body: { card_id (= user-card id), base_amount (>= 1), duration_minutes }.
 */
export async function listCardOnMarket(session: WikiSession, input: CreateListingInput): Promise<CreateListingResult> {
  return wikiMutate<CreateListingResult>(session, "/api/marketplace", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

/**
 * @dangerous Place a bid (spends wikibidous when outbid→held, wins→charged).
 * Amount must be >= minNextBid(auction.current_bid, auction.base_amount).
 */
export async function placeBid(session: WikiSession, auctionId: string, input: PlaceBidInput): Promise<PlaceBidResult> {
  return wikiMutate<PlaceBidResult>(session, `/api/marketplace/${auctionId}/bid`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

/**
 * @dangerous Lower the starting price. Site rules: only before the auction
 * midpoint, only if no bids, only once, only when base_amount > 1.
 */
export async function repriceAuction(session: WikiSession, auctionId: string, input: RepriceInput): Promise<RepriceResult> {
  return wikiMutate<RepriceResult>(session, `/api/marketplace/${auctionId}/reprice`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

/** @dangerous Settle a finished auction (transfers card / funds). */
export async function settleAuction(session: WikiSession, auctionId: string): Promise<SettleResult> {
  return wikiMutate<SettleResult>(session, `/api/marketplace/${auctionId}/settle`, {
    method: "POST",
  });
}

/** @dangerous Cancel your auction and recover the card. */
export async function cancelAuction(session: WikiSession, auctionId: string): Promise<unknown> {
  return wikiMutate<unknown>(session, `/api/marketplace/${auctionId}`, {
    method: "DELETE",
  });
}

/**
 * @dangerous Discard a card (DESTROY). The card is removed permanently;
 * the site grants +1 wikibidou per card.
 */
export async function discardCard(session: WikiSession, userCardId: string): Promise<DiscardResult> {
  return wikiMutate<DiscardResult>(session, `/api/user-cards/${userCardId}/discard`, {
    method: "POST",
  });
}

/** @dangerous Discard many cards at once (DESTROY). */
export async function bulkDiscardCards(session: WikiSession, input: BulkDiscardInput): Promise<BulkDiscardResult> {
  return wikiMutate<BulkDiscardResult>(session, "/api/user-cards/bulk-discard", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

// --- Collection listing -------------------------------------------------------

export async function getMyCollection(session: WikiSession, params: MyCollectionParams = {}): Promise<MyCollectionResult> {
  const q = new URLSearchParams();
  if (params.sort) q.set("sort", params.sort);
  if (params.q) q.set("q", params.q);
  for (const r of params.rarities ?? []) q.append("rarities", r);
  if (params.tagId) q.set("tagId", params.tagId);
  if (params.untagged) q.set("untagged", "1");
  if (params.wishlistedBy) q.set("wishlistedBy", params.wishlistedBy);
  if (params.page !== undefined) q.set("page", String(params.page));
  if (params.stats) q.set("stats", params.stats);
  if (params.owned_by) q.set("owned_by", params.owned_by);
  const qs = q.toString();
  return wikiJson<MyCollectionResult>(session, `/api/my-collection${qs ? `?${qs}` : ""}`);
}

/** Another user's public collection (read-only). */
export async function getUserCollection(
  session: WikiSession,
  userId: string,
  params: MyCollectionParams = {},
): Promise<MyCollectionResult> {
  const q = new URLSearchParams();
  if (params.sort) q.set("sort", params.sort);
  if (params.q) q.set("q", params.q);
  if (params.page !== undefined) q.set("page", String(params.page));
  if (params.stats) q.set("stats", params.stats);
  const qs = q.toString();
  return wikiJson<MyCollectionResult>(session, `/api/profile/${encodeURIComponent(userId)}/collection${qs ? `?${qs}` : ""}`);
}

// --- Trades -------------------------------------------------------------------

function calendarTzHeaders(): Record<string, string> {
  return { "x-wiki-calendar-tz": Intl.DateTimeFormat().resolvedOptions().timeZone };
}

/** All trades (incoming + outgoing), not just active ones. */
export async function getTrades(session: WikiSession): Promise<TradeList> {
  return wikiJson<TradeList>(session, "/api/trades");
}

/**
 * @dangerous Mutate a trade. action is one of "accept" | "decline" | "cancel".
 * Counter-offers go through createTrade() with parent_trade_id.
 */
export async function actOnTrade(session: WikiSession, tradeId: string, action: TradeAction): Promise<Trade> {
  return wikiMutate<Trade>(session, `/api/trades/${tradeId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...calendarTzHeaders() },
    body: JSON.stringify({ action }),
  });
}

/**
 * @dangerous Propose a trade (or counter-offer via parent_trade_id).
 * Moves reserved cards/wikibidous into escrow on accept.
 */
export async function createTrade(session: WikiSession, input: CreateTradeInput): Promise<CreateTradeResult> {
  return wikiMutate<CreateTradeResult>(session, "/api/trades", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...calendarTzHeaders() },
    body: JSON.stringify(input),
  });
}

// --- Friends / chat -------------------------------------------------------------

export async function getFriends(session: WikiSession): Promise<FriendList> {
  return wikiJson<FriendList>(session, "/api/friends");
}

export async function searchUsers(session: WikiSession, query: string): Promise<UserSearchResult> {
  return wikiJson<UserSearchResult>(session, `/api/friends/search?q=${encodeURIComponent(query)}`);
}

/** @dangerous Send a friend request. */
export async function addFriend(session: WikiSession, addresseeId: string): Promise<Friendship> {
  return wikiMutate<Friendship>(session, "/api/friends", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ addressee_id: addresseeId }),
  });
}

/** @dangerous Accept or decline a friend request. */
export async function actOnFriend(session: WikiSession, friendshipId: string, action: FriendAction): Promise<Friendship> {
  return wikiMutate<Friendship>(session, `/api/friends/${friendshipId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action }),
  });
}

/** @dangerous Accept all pending friend requests. */
export async function acceptAllFriends(session: WikiSession): Promise<FriendList> {
  return wikiMutate<FriendList>(session, "/api/friends/accept-all", {
    method: "POST",
  });
}

/** @dangerous Remove a friend. */
export async function removeFriend(session: WikiSession, friendshipId: string): Promise<unknown> {
  return wikiMutate<unknown>(session, `/api/friends/${friendshipId}`, {
    method: "DELETE",
  });
}

export async function getConversations(session: WikiSession): Promise<ConversationList> {
  return wikiJson<ConversationList>(session, "/api/chat");
}

export async function getConversation(session: WikiSession, peerId: string): Promise<ConversationDetail> {
  return wikiJson<ConversationDetail>(session, `/api/chat/${peerId}`);
}

/** @dangerous Send a direct message. */
export async function sendChatMessage(session: WikiSession, peerId: string, content: string): Promise<SentChatMessage> {
  return wikiMutate<SentChatMessage>(session, `/api/chat/${peerId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
}

// --- Guilds -----------------------------------------------------------------------

export async function getGuildHome(session: WikiSession): Promise<GuildHome> {
  return wikiJson<GuildHome>(session, "/api/guilds/home");
}

export async function getMyGuild(session: WikiSession): Promise<GuildHome> {
  return wikiJson<GuildHome>(session, "/api/guilds");
}

export async function getGuildMembers(session: WikiSession, limit = 50, offset = 0): Promise<GuildMemberList> {
  return wikiJson<GuildMemberList>(session, `/api/guilds/members?limit=${limit}&offset=${offset}`);
}

export async function getGuildMemberIds(session: WikiSession): Promise<GuildMemberIds> {
  return wikiJson<GuildMemberIds>(session, "/api/guilds/members?ids_only=1");
}

export async function getGuildLeaderboard(session: WikiSession): Promise<GuildLeaderboard> {
  return wikiJson<GuildLeaderboard>(session, "/api/guilds/leaderboard");
}

export async function getGuildChat(session: WikiSession): Promise<GuildChat> {
  return wikiJson<GuildChat>(session, "/api/guilds/chat");
}

export async function getZeventStandings(session: WikiSession): Promise<ZeventStandings> {
  return wikiJson<ZeventStandings>(session, "/api/guilds/zevent-standings");
}

/** @dangerous Create a guild. */
export async function createGuild(session: WikiSession, input: CreateGuildInput): Promise<GuildMutationResult> {
  return wikiMutate<GuildMutationResult>(session, "/api/guilds", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

/** @dangerous Rename / re-describe your guild (leader only). */
export async function updateGuild(session: WikiSession, input: UpdateGuildInput): Promise<GuildMutationResult> {
  return wikiMutate<GuildMutationResult>(session, "/api/guilds", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

/** @dangerous Join a guild (leaves current one). */
export async function joinGuild(session: WikiSession, guildId: string): Promise<GuildMutationResult> {
  return wikiMutate<GuildMutationResult>(session, "/api/guilds/join", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ guild_id: guildId }),
  });
}

/** @dangerous Leave your guild. */
export async function leaveGuild(session: WikiSession): Promise<unknown> {
  return wikiMutate<unknown>(session, "/api/guilds/leave", {
    method: "POST",
  });
}

/** @dangerous Invite a user to your guild. */
export async function inviteToGuild(session: WikiSession, userId: string): Promise<unknown> {
  return wikiMutate<unknown>(session, "/api/guilds/invite", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: userId }),
  });
}

/** @dangerous Kick a member (leader only). */
export async function kickFromGuild(session: WikiSession, userId: string): Promise<unknown> {
  return wikiMutate<unknown>(session, "/api/guilds/kick", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: userId }),
  });
}

/** @dangerous Transfer leadership (irreversible without the new leader's help). */
export async function transferGuildLeadership(session: WikiSession, userId: string): Promise<unknown> {
  return wikiMutate<unknown>(session, "/api/guilds/transfer-leadership", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: userId }),
  });
}

/** @dangerous Post a message to the guild chat. */
export async function sendGuildChatMessage(session: WikiSession, content: string): Promise<{ message: GuildChatMessage }> {
  return wikiMutate<{ message: GuildChatMessage }>(session, "/api/guilds/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
}

/** @dangerous Request a card from the guild wishlist. */
export async function requestGuildWishlistCard(session: WikiSession, cardId: string): Promise<GuildWishlistItem> {
  return wikiMutate<GuildWishlistItem>(session, "/api/guilds/wishlist", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ card_id: cardId }),
  });
}

/** @dangerous Withdraw your guild wishlist request. */
export async function withdrawGuildWishlist(session: WikiSession): Promise<unknown> {
  return wikiMutate<unknown>(session, "/api/guilds/wishlist", {
    method: "DELETE",
  });
}

/** @dangerous Donate one of your cards to a guildmate's wishlist request. */
export async function donateGuildWishlistCard(session: WikiSession, input: DonateCardInput): Promise<unknown> {
  return wikiMutate<unknown>(session, "/api/guilds/wishlist/donate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

// --- Battles / duels / parties ------------------------------------------------------

export async function getBattles(session: WikiSession): Promise<BattleList> {
  return wikiJson<BattleList>(session, "/api/battles");
}

/** @dangerous Challenge a friend to a battle (consumes daily challenge quota). */
export async function challengeToBattle(session: WikiSession, opponentId: string): Promise<CreatedBattle> {
  return wikiMutate<CreatedBattle>(session, "/api/battles", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ opponent_id: opponentId }),
  });
}

/** @dangerous Withdraw / decline / forfeit / accept / play a battle turn. */
export async function actOnBattle(session: WikiSession, battleId: string, input: BattleActionInput): Promise<BattleTurnResult> {
  return wikiMutate<BattleTurnResult>(session, `/api/battles/${battleId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

/** Single battle detail incl. game_state (read-only). */
export async function getBattleDetail(session: WikiSession, battleId: string): Promise<BattleDetail> {
  return wikiJson<BattleDetail>(session, `/api/battles/${battleId}`);
}

export async function getDuels(session: WikiSession): Promise<DuelList> {
  return wikiJson<DuelList>(session, "/api/duels");
}

/** @dangerous Start a duel with a friend. */
export async function challengeToDuel(session: WikiSession, opponentId: string): Promise<CreatedDuel> {
  return wikiMutate<CreatedDuel>(session, "/api/duels", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ opponent_id: opponentId }),
  });
}

export async function getPartyQuota(session: WikiSession): Promise<PartyQuota> {
  return wikiJson<PartyQuota>(session, "/api/parties");
}

/** @dangerous Create a party group (consumes party quota). */
export async function createParty(session: WikiSession): Promise<CreatedParty> {
  return wikiMutate<CreatedParty>(session, "/api/parties", {
    method: "POST",
  });
}

// --- Showcase / profile ---------------------------------------------------------------

export async function getShowcase(session: WikiSession): Promise<ShowcaseResult> {
  return wikiJson<ShowcaseResult>(session, "/api/showcase");
}

/** @dangerous Place a card in a showcase slot. */
export async function setShowcaseSlot(session: WikiSession, input: SetShowcaseInput): Promise<ShowcaseResult> {
  return wikiMutate<ShowcaseResult>(session, "/api/showcase", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

/** @dangerous Clear a showcase slot. */
export async function clearShowcaseSlot(session: WikiSession, input: ClearShowcaseInput): Promise<ShowcaseResult> {
  return wikiMutate<ShowcaseResult>(session, "/api/showcase", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

/** @dangerous Rename a showcase gallery. */
export async function renameShowcaseGallery(session: WikiSession, input: RenameGalleryInput): Promise<unknown> {
  return wikiMutate<unknown>(session, "/api/showcase/gallery", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

/** @dangerous Update a profile (visibility, avatar, …). */
export async function updateProfile(session: WikiSession, username: string, input: UpdateProfileInput): Promise<UpdatedProfile> {
  return wikiMutate<UpdatedProfile>(session, `/api/profile/${encodeURIComponent(username)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function checkUsernameAvailable(session: WikiSession, username: string): Promise<UsernameAvailability> {
  return wikiJson<UsernameAvailability>(session, `/api/auth/username-available?u=${encodeURIComponent(username)}&self=1`);
}

// --- Achievements / reports / appeals ----------------------------------------------------

export async function syncAchievements(session: WikiSession): Promise<unknown> {
  return wikiJson<unknown>(session, "/api/achievements/check", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event: "achievements_sync" }),
  });
}

/** @dangerous Claim an achievement reward (credits wikibidous). */
export async function claimAchievement(session: WikiSession, achievementId: string): Promise<AchievementClaimResult> {
  return wikiMutate<AchievementClaimResult>(session, "/api/achievements/claim", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ achievement_id: achievementId }),
  });
}

export async function getExistingReport(session: WikiSession, reportedUserId: string): Promise<ExistingReport> {
  return wikiJson<ExistingReport>(session, `/api/reports?reportedUserId=${encodeURIComponent(reportedUserId)}`);
}

/** @dangerous File a report against a user. */
export async function fileReport(session: WikiSession, input: ReportInput): Promise<unknown> {
  return wikiMutate<unknown>(session, "/api/reports", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

/** @dangerous Appeal a sanction (message to moderators). */
export async function fileAppeal(session: WikiSession, input: AppealInput): Promise<unknown> {
  return wikiMutate<unknown>(session, "/api/appeals", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

// --- Billing (real money — never call automatically) ---------------------------------------

/**
 * @dangerous Start a Stripe checkout (kind "pro" = subscription,
 * "packs"/"wb_2500"/… = one-off). Redirect the user to result.url.
 */
export async function startCheckout(session: WikiSession, input: CheckoutInput): Promise<CheckoutResult> {
  return wikiMutate<CheckoutResult>(session, "/api/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

/** @dangerous Open the Stripe billing portal (manage/cancel subscription). */
export async function openBillingPortal(session: WikiSession): Promise<BillingPortalResult> {
  return wikiMutate<BillingPortalResult>(session, "/api/billing/portal", {
    method: "POST",
  });
}

/** @dangerous Verify an App Store receipt (kind "packs" | "pro_subscription" | "wikibidous_purchase"). */
export async function verifyIapReceipt(session: WikiSession, input: IapVerifyInput): Promise<unknown> {
  return wikiMutate<unknown>(session, "/api/iap/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

/**
 * @dangerous Delete the account. IRREVERSIBLE. Included for coverage only —
 * never wire to automation.
 */
export async function deleteAccount(session: WikiSession): Promise<unknown> {
  return wikiMutate<unknown>(session, "/api/account", {
    method: "DELETE",
  });
}

// --- Auth helpers / push ---------------------------------------------------------------------

export async function logSecurityEvent(session: WikiSession, input: LogSecurityEventInput): Promise<unknown> {
  return wikiMutate<unknown>(session, "/api/auth/log-security-event", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function postConfirmation(session: WikiSession, input: PostConfirmationInput): Promise<unknown> {
  return wikiMutate<unknown>(session, "/api/auth/post-confirmation", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function getPushSubscription(session: WikiSession): Promise<{ subscription: PushSubscriptionPayload | null }> {
  return wikiJson(session, "/api/push/web-subscription");
}

/** @dangerous Register a Web Push subscription (browser PushManager required). */
export async function subscribePush(session: WikiSession, subscription: PushSubscriptionPayload): Promise<unknown> {
  return wikiMutate<unknown>(session, "/api/push/web-subscription", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subscription }),
  });
}

/** @dangerous Remove the Web Push subscription. */
export async function unsubscribePush(session: WikiSession): Promise<unknown> {
  return wikiMutate<unknown>(session, "/api/push/web-subscription", {
    method: "DELETE",
  });
}

// --- Global card catalog / web graph / image reports -------------------------------

/** Global card catalog search (read-only). */
export async function searchCards(session: WikiSession, params: CardCatalogParams = {}): Promise<CardCatalogResult> {
  const q = new URLSearchParams();
  if (params.page !== undefined) q.set("page", String(params.page));
  if (params.search) q.set("q", params.search);
  for (const r of params.rarityFilter ?? []) q.append("rarity", r);
  if (params.sortField) q.set("sort", params.sortField);
  if (params.wishlist) q.set("wishlist", "1");
  const qs = q.toString();
  return wikiJson<CardCatalogResult>(session, `/api/cards${qs ? `?${qs}` : ""}`);
}

/** Card relation-graph ("Toile") data (read-only). NOTE: PRO-gated, 403 for non-PRO. */
export async function getCardWeb(session: WikiSession, cardId: string, scope: string, pin?: string): Promise<CardWebResult> {
  const q = new URLSearchParams({ scope });
  if (pin) q.set("pin", pin);
  return wikiJson<CardWebResult>(session, `/api/cards/${cardId}/web?${q.toString()}`);
}

/** Card ids the user already image-reported (read-only). */
export async function getMyImageReports(session: WikiSession): Promise<ImageReportsMine> {
  return wikiJson<ImageReportsMine>(session, "/api/image-reports/mine");
}

/** @dangerous Report a card's image. Toggle off with unreportCardImage(). */
export async function reportCardImage(session: WikiSession, cardId: string): Promise<unknown> {
  return wikiMutate<unknown>(session, `/api/cards/${cardId}/image-report`, { method: "POST" });
}

/** @dangerous Withdraw a card image report. */
export async function unreportCardImage(session: WikiSession, cardId: string): Promise<unknown> {
  return wikiMutate<unknown>(session, `/api/cards/${cardId}/image-report`, { method: "DELETE" });
}
