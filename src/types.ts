// Central type definitions for the wikimasters-bot.
// Reverse-engineered from https://www.wiki-masters.com/_next/static/chunks/*.js
// and live API responses. No code here performs any network call.

export type Rarity = "C" | "PC" | "R" | "UR" | "SR" | "L";

// --- Auth session -----------------------------------------------------------

export interface SupabaseUser {
  id: string;
  email?: string;
  [k: string]: unknown;
}

export interface WikiSession {
  access_token: string;
  refresh_token: string;
  expires_at: number; // unix seconds
  expires_in: number;
  token_type: string;
  user: SupabaseUser;
  [k: string]: unknown;
}

// --- Profile / packs --------------------------------------------------------

export interface Profile {
  id: string;
  username: string;
  is_pro: boolean;
  is_vip: boolean;
  is_admin: boolean;
  packs_remaining: number;
  packs_last_regen_at: string | null;
  pack_human_verified_at: string | null;
  last_normal_pack_opened_at: string | null;
  activity_blocked_until: string | null;
  wikibidous_balance: number;
  pity_counter: number;
  cheat_strikes: number;
  [k: string]: unknown;
}

export interface PackCard {
  id: string;
  wikipedia_title: string;
  rarity: string;
  atk: number;
  def: number;
  pageviews: number;
  [k: string]: unknown;
}

export interface OpenPackResult {
  cards: PackCard[];
  packs_remaining: number;
  packs_last_regen_at: string;
  human_verification_required?: boolean;
  error?: string;
}

export interface OpenPackErrorData {
  human_verification_required?: boolean;
  packs_remaining?: number;
  error?: string;
}

export interface HumanVerifyResult {
  pack_human_verified_at: string;
}

export interface CollectionStats {
  total: number;
  rarityCounts: Record<string, number>;
  tagOptions?: unknown[];
  [k: string]: unknown;
}

export interface SpecialPacksResult {
  packs: SpecialPackInfo[];
  available: boolean;
  next_available_at?: string | null;
  is_vip?: boolean;
  [k: string]: unknown;
}

export interface ProDailyStatus {
  eligible: boolean;
  claimed_today: boolean;
  claim_date: string;
}

/** Result of POST /api/packs/pro-daily, POST /api/packs/special, POST /api/packs/grace.
 * Probed 2026-09-22: GET shapes are {eligible, claimed_today, claim_date} and
 * {packs, available}; POST when ineligible/disabled returns {error} with
 * 403/404. Success shape unobserved (account is non-PRO, no specials active)
 * — assumed to mirror OpenPackResult ({cards, ...}), fields optional. */
export interface ClaimPackResult {
  cards?: PackCard[];
  packs_remaining?: number;
  packs_last_regen_at?: string;
  error?: string;
  [k: string]: unknown;
}

export interface SpecialPackInfo {
  id?: string;
  [k: string]: unknown;
}

// --- Notifications / trades -------------------------------------------------

export interface NotificationItem {
  id: string;
  user_id: string;
  type: string;
  data: Record<string, unknown>;
  read: boolean;
  created_at: string;
}

export interface NotificationList {
  notifications: NotificationItem[];
}

export interface TradeList {
  trades: unknown[];
}

export interface WikibidousBalance {
  balance: number;
}

// --- Marketplace ------------------------------------------------------------

export interface AuctionSeller {
  id: string;
  username: string;
  avatar_url: string | null;
  avatar_pos_x?: number;
  avatar_pos_y?: number;
}

export interface AuctionBidder {
  id: string;
  username: string;
}

export interface AuctionCard {
  id: string;
  atk: number;
  def: number;
  lang: string;
  rarity: string;
  q_score: number;
  category: string | null;
  image_url: string | null;
  pageviews: number;
  wikipedia_url?: string;
  [k: string]: unknown;
}

export interface Auction {
  id: string;
  seller_id: string;
  card_id: string;
  base_amount: number;
  current_bid: number | null;
  current_bidder_id: string | null;
  end_at: string;
  status: string;
  winner_id: string | null;
  final_price: number | null;
  created_at: string;
  settled_at: string | null;
  snapshot_rarity: string;
  snapshot_atk: number;
  snapshot_def: number;
  effective_bid: number;
  listing_base_amount: number;
  base_repriced_at: string | null;
  is_shiny: boolean;
  seller?: AuctionSeller | null;
  current_bidder?: AuctionBidder | null;
  winner?: AuctionBidder | null;
  card?: AuctionCard | null;
  [k: string]: unknown;
}

export interface AuctionBid {
  id?: string;
  auction_id?: string;
  bidder_id?: string;
  amount: number;
  bidder?: AuctionBidder | null;
  created_at?: string;
  [k: string]: unknown;
}

export interface AuctionDetail {
  auction: Auction;
  bids: AuctionBid[];
}

export interface MarketplaceMine {
  selling: Auction[];
  bidding: Auction[];
  won: Auction[];
  history: Auction[];
  sellingCount?: number | null;
  maxConcurrentAuctions?: number;
}

export interface MarketplaceBrowseParams {
  page?: number;
  limit?: number;
  search?: string;
  sort?: "recent" | "price_asc" | "price_desc" | "ending_soon";
  rarities?: string[];
  mine?: boolean;
}

export interface MarketplaceBrowseResult {
  auctions: Auction[];
  total: number;
  hasMore: boolean;
  selling?: Auction[];
  bidding?: Auction[];
  won?: Auction[];
  history?: Auction[];
  maxConcurrentAuctions?: number;
  mine?: MarketplaceMine;
}

export interface CreateListingInput {
  /** NOTE: despite the name, the site sends the user-card id in this field. */
  card_id: string;
  base_amount: number;
  /** One of 10 | 30 | 60 | 180 | 360 | 720 | 1440 (see site listing modal). */
  duration_minutes: number;
}

export interface CreateListingResult {
  auction_id: string;
}

export interface PlaceBidInput {
  amount: number;
}

export interface PlaceBidResult {
  auction: Auction;
  bids?: AuctionBid[];
  [k: string]: unknown;
}

export interface RepriceInput {
  new_base_amount: number;
}

export interface RepriceResult {
  auction: Auction;
  [k: string]: unknown;
}

export interface SettleResult {
  auction: Auction;
  [k: string]: unknown;
}

/** Per-rarity sales summary used for average market value. */
export interface RaritySaleSummary {
  count?: number;
  latest?: number;
  average?: number;
}

export interface CardSalesSummary {
  summary: Partial<Record<Rarity | string, RaritySaleSummary>>;
}

export interface CardSale {
  final_price: number;
  rarity: string;
  sold_at?: string;
  [k: string]: unknown;
}

export interface CardSalesHistory {
  sales: CardSale[];
}

// --- Collection (discard) ----------------------------------------------------

export interface DiscardResult {
  wikibidous_balance?: number;
  discarded_count?: number;
  [k: string]: unknown;
}

export interface BulkDiscardInput {
  card_ids: string[];
}

export interface BulkDiscardResult {
  discarded_count: number;
  failed: string[];
  [k: string]: unknown;
}

// --- Errors ------------------------------------------------------------------

export interface ApiErrorData {
  error?: string;
  code?: string;
  human_verification_required?: boolean;
  packs_remaining?: number;
  next_available_at?: string;
  [k: string]: unknown;
}

// --- Collection listing ------------------------------------------------------

export interface CollectionItem {
  id: string;
  user_id: string;
  card_id: string;
  count?: number;
  starred: boolean;
  obtained_at?: string;
  is_shiny?: boolean;
  snapshot_rarity?: string;
  snapshot_atk?: number;
  snapshot_def?: number;
  owned_by_peer?: string;
  card: PackCard;
  [k: string]: unknown;
}

export interface MyCollectionParams {
  sort?: string;
  q?: string;
  rarities?: string[];
  tagId?: string;
  untagged?: boolean;
  wishlistedBy?: string;
  page?: number;
  stats?: string;
  owned_by?: string;
}

export interface MyCollectionResult {
  collection: CollectionItem[];
  total?: number | string | null;
  tagOptions?: unknown[];
  [k: string]: unknown;
}

export interface Tag {
  id: string;
  user_id: string;
  name: string;
  color: string | null;
}

export interface WishlistEntry {
  card_id: string;
  [k: string]: unknown;
}

// --- Trades ------------------------------------------------------------------

export type TradeAction = "accept" | "decline" | "cancel";

export interface TradeItem {
  user_card_id: string;
  card_id: string;
  offered_by: string;
}

export interface Trade {
  id: string;
  initiator_id: string;
  recipient_id: string;
  status: string;
  initiator_wikibidous?: number;
  recipient_wikibidous?: number;
  parent_trade_id?: string | null;
  items?: TradeItem[];
  created_at?: string;
  [k: string]: unknown;
}

export interface CreateTradeInput {
  recipient_id: string;
  items: TradeItem[];
  initiator_wikibidous: number;
  recipient_wikibidous: number;
  parent_trade_id?: string;
}

export interface CreateTradeResult {
  trade: Trade;
  [k: string]: unknown;
}

// --- Friends / chat ------------------------------------------------------------

export interface Friendship {
  id: string;
  requester_id: string;
  addressee_id: string;
  status: string;
  requester?: { id: string; username: string; [k: string]: unknown } | null;
  addressee?: { id: string; username: string; [k: string]: unknown } | null;
  [k: string]: unknown;
}

export interface FriendCounts {
  accepted: number;
  incoming: number;
  outgoing: number;
}

export interface FriendList {
  friendships: Friendship[];
  counts?: FriendCounts;
}

export type FriendAction = "accept" | "decline";

export interface SearchedUser {
  id: string;
  username: string;
  friendship?: { id: string; status: string; isRequester: boolean } | null;
  [k: string]: unknown;
}

export interface UserSearchResult {
  users: SearchedUser[];
}

export interface ChatMessage {
  id: string;
  sender_id: string;
  content: string;
  read: boolean;
  created_at: string;
}

export interface Conversation {
  peer_id?: string;
  peer?: { id: string; username: string; [k: string]: unknown };
  last_message?: ChatMessage | null;
  unread_count?: number;
  [k: string]: unknown;
}

export interface ConversationList {
  conversations: Conversation[];
}

export interface ConversationDetail {
  messages: ChatMessage[];
  trades: Trade[];
}

export interface SentChatMessage {
  message: ChatMessage;
}

// --- Guilds --------------------------------------------------------------------

export interface Guild {
  id: string;
  name: string;
  description?: string | null;
  karma_this_week?: number;
  donations_this_week?: number;
  [k: string]: unknown;
}

export interface GuildMembership {
  user_id: string;
  guild_id: string;
  role?: string;
  [k: string]: unknown;
}

export interface GuildHome {
  guild: Guild;
  membership?: GuildMembership | null;
  leaderboard?: unknown;
  my_contribution?: Record<string, number> | null;
  [k: string]: unknown;
}

export interface GuildMember {
  user_id: string;
  profile: { id: string; username: string; [k: string]: unknown };
  [k: string]: unknown;
}

export interface GuildMemberList {
  members: GuildMember[];
  total: number;
  leader_count?: number;
  has_more?: boolean;
}

export interface GuildMemberIds {
  member_ids: string[];
}

export interface GuildLeaderboard {
  entries: unknown[];
  user_guild_id?: string | null;
}

export interface GuildChatMessage {
  id: string;
  sender_id: string;
  content: string;
  created_at: string;
  sender?: unknown;
}

export interface GuildChat {
  messages: GuildChatMessage[];
}

export interface GuildWishlistItem {
  id: string;
  card_id: string;
  owned_copy_ids?: string[];
  [k: string]: unknown;
}

export interface CreateGuildInput {
  name: string;
  description?: string;
}

export interface UpdateGuildInput {
  name?: string;
  description?: string | null;
}

export interface GuildMutationResult {
  guild: Guild;
  [k: string]: unknown;
}

export interface DonateCardInput {
  wishlist_id: string;
  user_card_id: string;
}

export interface ZeventStandings {
  [k: string]: unknown;
}

// --- Battles / duels / parties ---------------------------------------------------

export type BattleAction = "withdraw_invite" | "decline" | "forfeit" | "accept" | "submit_deck" | "submit_attack" | "submit_single_answer";

export interface BattleActionInput {
  action: BattleAction;
  /** submit_deck: user-card ids forming the battle deck. */
  card_ids?: string[];
  /** submit_attack: user-card id leading the attack. */
  attack_card_id?: string;
  /** submit_single_answer: quiz identifiers. */
  questionId?: string;
  answerId?: string;
}

export interface BattleDetail {
  battle: Battle;
}

export interface BattleTurnResult {
  game_state: Record<string, unknown>;
  winner_id?: string | null;
  last_turn?: Record<string, unknown> | null;
  correct_option_id?: string | null;
  [k: string]: unknown;
}

export interface Battle {
  id: string;
  challenger_id: string;
  opponent_id?: string;
  status: string;
  winner_id?: string | null;
  challenger?: unknown;
  opponent?: unknown;
  [k: string]: unknown;
}

export interface BattleQuota {
  used: number;
  limit: number;
}

export interface BattleList {
  battles: Battle[];
  challenge_quota?: BattleQuota;
}

export interface CreatedBattle {
  battle: Battle;
  challenge_quota?: BattleQuota;
}

export interface Duel {
  id: string;
  status: string;
  [k: string]: unknown;
}

export interface DuelList {
  duels: Duel[];
  can_create?: boolean;
}

export interface CreatedDuel {
  duel?: Duel;
  duel_id?: string;
}

export interface PartyQuota {
  party_quota?: BattleQuota;
}

export interface CreatedParty {
  code: string;
  party_quota?: BattleQuota;
}

// --- Showcase / profile ----------------------------------------------------------

export interface ShowcaseSlot {
  position: number;
  userCard: CollectionItem | null;
}

export interface ShowcaseResult {
  showcase: Array<{
    position: number;
    user_card?: { id: string; card: PackCard; [k: string]: unknown } | null;
    [k: string]: unknown;
  }>;
}

export interface SetShowcaseInput {
  position: number;
  user_card_id: string;
}

export interface ClearShowcaseInput {
  position: number;
}

export interface RenameGalleryInput {
  gallery_index: number;
  name: string;
}

export interface UpdateProfileInput {
  [k: string]: unknown;
}

export interface UpdatedProfile {
  profile: Profile;
}

export interface UsernameAvailability {
  available: boolean;
}

// --- Achievements / reports / appeals ----------------------------------------------

export interface Achievement {
  id: string;
  code: string;
  title: string;
  description?: string;
  icon?: string;
  wikibidous_reward?: number;
  [k: string]: unknown;
}

export interface UserAchievement {
  user_id: string;
  achievement_id: string;
  unlocked_at?: string | null;
  claimed_at?: string | null;
  [k: string]: unknown;
}

export interface AchievementClaimResult {
  claimed_at?: string;
  already_claimed?: boolean;
  amount?: number;
  [k: string]: unknown;
}

export interface ReportInput {
  reportedUserId: string;
  reason: string;
  details: string;
}

export interface ExistingReport {
  report: { reason: string; details?: string; [k: string]: unknown } | null;
}

export interface AppealInput {
  sanction_id: string;
  message: string;
}

// --- Billing -----------------------------------------------------------------------

export type CheckoutKind = "pro" | "packs" | "wb_2500" | "wb_5000" | string;

export interface CheckoutInput {
  kind: CheckoutKind;
}

export interface CheckoutResult {
  url: string;
}

export interface BillingPortalResult {
  url: string;
}

export interface IapVerifyInput {
  receipt: string;
  transactionId?: string;
  kind: "packs" | "pro_subscription" | "wikibidous_purchase" | string;
  productId: string;
}

// --- Auth helpers / push ---------------------------------------------------------------

export interface LogSecurityEventInput {
  eventType: string;
  email?: string;
  success?: boolean;
  failureReason?: string;
  accessToken?: string;
}

export interface PostConfirmationInput {
  accessToken: string;
  refreshToken: string;
}

export interface PushSubscriptionPayload {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  [k: string]: unknown;
}

// --- Global card catalog / web graph / image reports ----------------------------

export interface CardCatalogParams {
  page?: number;
  search?: string;
  rarityFilter?: string[];
  sortField?: string;
  wishlist?: boolean;
}

export interface CardCatalogResult {
  cards: PackCard[];
  total?: number | string | null;
  searchHasMore?: boolean;
  rarityCounts?: Record<string, number> | null;
  [k: string]: unknown;
}

export interface CardWebResult {
  pinId?: string | null;
  [k: string]: unknown;
}

export interface ImageReportsMine {
  cardIds: string[];
}

// --- Supabase-direct rows (client uses supabase-js, no /api route) ---------------

export interface TagCreateResult {
  tag: Tag;
  created: boolean;
}

export interface UserCardTagRow {
  tag: Tag;
}

export interface UserCardRow {
  id: string;
  card_id: string;
  starred: boolean;
  is_shiny?: boolean;
  user_card_tags?: UserCardTagRow[];
  [k: string]: unknown;
}

// --- Realtime ----------------------------------------------------------------------

export type BattleBroadcastEvent =
  | "attack_submitted"
  | "defense_graded"
  | "deck_ready"
  | "forfeit"
  | "game_state_sync"
  | "battle_updated"
  | "quiz_progress";

export interface BattleBroadcastPayload {
  userId?: string;
  newStatus?: string;
  cardId?: string;
  [k: string]: unknown;
}

export interface AuctionBidPayload {
  amount: number;
  bidder_id?: string;
  bidder?: { id: string; username: string };
  [k: string]: unknown;
}

export interface RealtimeSubscription {
  unsubscribe: () => Promise<void>;
}
