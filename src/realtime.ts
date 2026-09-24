// Supabase Realtime transport (works on Bun — supabase-js uses WebSocket).
// Mirrors the site's channels (verified against wm/ws.txt + 12bza1lp3l6p-.js):
// - notifications:${uid} broadcast INSERT, private channel (payload.record = row)
// - profile:${uid} broadcast UPDATE, private channel (payload.record = profiles row)
// - battle:${id} broadcast (attack_submitted, defense_graded, deck_ready,
//   forfeit, game_state_sync, battle_updated, quiz_progress)
// - battle-presence:${id} presence (who is online in the room)
// - auction:${id} broadcast, private channel (BID, UPDATE) — needs setAuth
// - chat:${a}:${b} + dms-list:${uid} postgres_changes on chat_messages
import { createClient, type RealtimeChannel, type SupabaseClient } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./config.ts";
import type {
  AuctionBidPayload,
  BattleBroadcastEvent,
  BattleBroadcastPayload,
  NotificationItem,
  RealtimeSubscription,
  WikiSession,
} from "./types.ts";

export async function connectRealtime(session: WikiSession): Promise<SupabaseClient> {
  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await sb.auth.setSession({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
  });
  if (error) throw new Error(`realtime setSession: ${error.message}`);
  // Private channels (auction:*) authorize against this token (site calls realtime.setAuth()).
  sb.realtime.setAuth(session.access_token);
  return sb;
}

function wrap(channel: RealtimeChannel, sb: SupabaseClient): RealtimeSubscription {
  return {
    async unsubscribe() {
      await sb.removeChannel(channel);
    },
  };
}

export type BattleEventHandler = (event: BattleBroadcastEvent, payload: BattleBroadcastPayload) => void;

const BATTLE_EVENTS: BattleBroadcastEvent[] = [
  "attack_submitted",
  "defense_graded",
  "deck_ready",
  "forfeit",
  "game_state_sync",
  "battle_updated",
  "quiz_progress",
];

/** Live battle room feed. Sending is left to the caller via the returned send(). */
export async function subscribeBattle(
  sb: SupabaseClient,
  battleId: string,
  onEvent: BattleEventHandler,
): Promise<RealtimeSubscription & { send: (event: BattleBroadcastEvent, payload: BattleBroadcastPayload) => void }> {
  const channel = sb.channel(`battle:${battleId}`);
  for (const event of BATTLE_EVENTS) {
    channel.on("broadcast", { event }, ({ payload }) => onEvent(event, payload as BattleBroadcastPayload));
  }
  await waitForSubscribed(channel);
  return {
    ...wrap(channel, sb),
    send: (event, payload) => void channel.send({ type: "broadcast", event, payload }),
  };
}

/** Presence: who is currently in the battle room. */
export async function trackBattlePresence(
  sb: SupabaseClient,
  battleId: string,
  userId: string,
  onSync: (userIds: string[]) => void,
): Promise<RealtimeSubscription> {
  const channel = sb.channel(`battle-presence:${battleId}`);
  channel.on("presence", { event: "sync" }, () => {
    const ids = [
      ...new Set(
        Object.values(channel.presenceState())
          .flat()
          .map((p) => (p as unknown as { user_id: string }).user_id)
          .filter(Boolean),
      ),
    ];
    onSync(ids);
  });
  await waitForSubscribed(channel);
  await channel.track({ user_id: userId });
  return wrap(channel, sb);
}

/** Live auction feed (bids + price updates). Read-only subscribe. */
export async function subscribeAuction(
  sb: SupabaseClient,
  auctionId: string,
  handlers: { onBid?: (bid: AuctionBidPayload, endAt?: string) => void; onUpdate?: () => void },
): Promise<RealtimeSubscription> {
  const channel = sb.channel(`auction:${auctionId}`, { config: { private: true } });
  channel.on("broadcast", { event: "BID" }, ({ payload }) => {
    const p = payload as { bid?: AuctionBidPayload; end_at?: string; previous_bidder_id?: string };
    if (p?.bid) handlers.onBid?.(p.bid, p.end_at);
  });
  channel.on("broadcast", { event: "UPDATE" }, () => handlers.onUpdate?.());
  await waitForSubscribed(channel);
  return wrap(channel, sb);
}

/** Live incoming DMs for one peer pair (read-only). */
export async function subscribeChat(
  sb: SupabaseClient,
  myId: string,
  peerId: string,
  onMessage: (message: Record<string, unknown>) => void,
): Promise<RealtimeSubscription> {
  const [a, b] = [myId, peerId].sort();
  const channel = sb
    .channel(`chat:${a}:${b}`)
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "chat_messages", filter: `sender_id=eq.${peerId}` },
      (payload) => onMessage(payload.new as Record<string, unknown>),
    );
  await waitForSubscribed(channel);
  return wrap(channel, sb);
}

/** Firehose for every incoming DM (read-only, drives the dms list refresh). */
export async function subscribeDmsList(sb: SupabaseClient, userId: string, onInsert: () => void): Promise<RealtimeSubscription> {
  const channel = sb
    .channel(`dms-list:${userId}`)
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "chat_messages", filter: `recipient_id=eq.${userId}` },
      () => onInsert(),
    );
  await waitForSubscribed(channel);
  return wrap(channel, sb);
}

function waitForSubscribed(channel: RealtimeChannel, timeoutMs = 20_000): Promise<void> {
  return new Promise((resolve, reject) => {
    // The phoenix client auto-retries failed joins (this network drops the
    // first attempt regularly), so only the timeout is a real failure.
    const timer = setTimeout(() => reject(new Error("realtime subscribe timed out")), timeoutMs);
    channel.subscribe((status) => {
      if (status === "SUBSCRIBED") {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Subscribe with fresh re-subscribes. The gateway rate-limits private joins
 * (`ConnectionRateLimitReached`, captured in wm/ws.txt) and a rejected join
 * needs a new subscribe — waiting on one channel is not enough.
 */
async function subscribeWithRetry(
  sb: SupabaseClient,
  make: () => RealtimeChannel,
  opts: { attempts?: number; baseDelayMs?: number; timeoutMs?: number } = {},
): Promise<RealtimeSubscription> {
  const attempts = opts.attempts ?? 5;
  const base = opts.baseDelayMs ?? 2000;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  let lastErr = "";
  for (let i = 0; i < attempts; i++) {
    const channel = make();
    try {
      await waitForSubscribed(channel, timeoutMs);
      return wrap(channel, sb);
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      await sb.removeChannel(channel).catch(() => undefined);
      if (i + 1 < attempts) await sleep(base * 2 ** i);
    }
  }
  throw new Error(`realtime subscribe failed after ${attempts} attempts: ${lastErr}`);
}

export type NotificationHandler = (notification: NotificationItem) => void;

/**
 * Live notifications feed. Read-only subscribe. The site refetches the list
 * on SUBSCRIBED; the record arrives via broadcast so callers can skip that.
 */
export async function subscribeNotifications(
  sb: SupabaseClient,
  userId: string,
  onInsert: NotificationHandler,
): Promise<RealtimeSubscription> {
  return subscribeWithRetry(sb, () => {
    const channel = sb.channel(`notifications:${userId}`, { config: { private: true } });
    channel.on("broadcast", { event: "INSERT" }, ({ payload }) => {
      const record = (payload as { record?: NotificationItem } | null)?.record;
      if (record?.id) onInsert(record);
    });
    return channel;
  });
}

export type ProfileUpdateHandler = (record: Record<string, unknown> | null) => void;

/**
 * Live profile updates (balance, packs, regen). Read-only subscribe. The
 * site refetches the profile on UPDATE; the full row also arrives as
 * payload.record (see wm/ws.txt binary frame), passed through when present.
 */
export async function subscribeProfile(
  sb: SupabaseClient,
  userId: string,
  onUpdate: ProfileUpdateHandler,
): Promise<RealtimeSubscription> {
  return subscribeWithRetry(sb, () => {
    const channel = sb.channel(`profile:${userId}`, { config: { private: true } });
    channel.on("broadcast", { event: "UPDATE" }, ({ payload }) => {
      const p = payload as { record?: Record<string, unknown> } | null;
      onUpdate(p && typeof p.record === "object" && p.record !== null ? p.record : null);
    });
    return channel;
  });
}

export type SubscriptionFactory = (sb: SupabaseClient) => Promise<RealtimeSubscription>;

/**
 * Owns one socket plus all subscriptions on it. Factories are re-run on
 * reconnect, so callers never reimplement rotation/resubscribe loops.
 */
export class RealtimeManager {
  private sb: SupabaseClient | null = null;
  private factories: SubscriptionFactory[] = [];

  private constructor() {}

  static async connect(session: WikiSession): Promise<RealtimeManager> {
    const m = new RealtimeManager();
    m.sb = await connectRealtime(session);
    return m;
  }

  private requireSocket(): SupabaseClient {
    if (!this.sb) throw new Error("realtime manager is closed");
    return this.sb;
  }

  /** Subscribe now and track the factory for future reconnects. */
  async add(make: SubscriptionFactory): Promise<RealtimeSubscription> {
    const sub = await make(this.requireSocket());
    this.factories.push(make);
    return sub;
  }

  /** Drop everything, open a fresh socket (new token), resubscribe all. */
  async reconnect(session: WikiSession): Promise<void> {
    const old = this.sb;
    this.sb = null;
    if (old) {
      await old.removeAllChannels().catch(() => undefined);
      old.realtime.disconnect();
    }
    this.sb = await connectRealtime(session);
    const factories = this.factories;
    this.factories = [];
    for (const make of factories) await this.add(make);
  }

  get connected(): boolean {
    return this.sb?.realtime.isConnected() ?? false;
  }

  async close(): Promise<void> {
    const old = this.sb;
    this.sb = null;
    this.factories = [];
    if (old) {
      await old.removeAllChannels().catch(() => undefined);
      old.realtime.disconnect();
    }
  }
}
