// Notifications daemon: live realtime feed + periodic resync, tracks seen
// ids, pushes marketplace / auction / trade events to the Telegram owner chat.
//
// State: .notifications-seen.json (git-ignored) holds seen notification ids.
// Target: TELEGRAM_BOT_TOKEN + TELEGRAM_OWNER_ID env (.env), gated on
// TELEGRAM_LOGS=1. Without it, events only log.
import { SEEN_NOTIFICATIONS_FILE } from "./config.ts";
import { getMyNotifications } from "./supabase.ts";
import type { NotificationItem, WikiSession } from "./types.ts";

/** Notification types forwarded to Telegram. Observed live 2026-09-22:
// marketplace_wishlist_listed, marketplace_auction_won. Plan adds
// marketplace_outbid / auction_won / auction_sold. Match broadly. */
const DEFAULT_TYPES = ["marketplace_", "auction_"];

export function shouldForward(n: NotificationItem, prefixes: string[] = DEFAULT_TYPES): boolean {
  return prefixes.some((p) => n.type.startsWith(p));
}

// Serializes every seen-file read-modify-write (live events can arrive in
// bursts while a resync holds the file — without this, concurrent passes
// overwrite each other and already-forwarded ids get re-forwarded).
let seenTail: Promise<void> = Promise.resolve();

function seenExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = seenTail.then(fn);
  seenTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export async function loadSeenIds(): Promise<Set<string>> {
  try {
    const f = Bun.file(SEEN_NOTIFICATIONS_FILE);
    if (!(await f.exists())) return new Set();
    const arr = (await f.json()) as string[];
    return new Set(arr);
  } catch {
    return new Set();
  }
}

export async function saveSeenIds(ids: Set<string>): Promise<void> {
  const arr = [...ids].slice(-1000); // cap file growth
  await Bun.write(SEEN_NOTIFICATIONS_FILE, JSON.stringify(arr));
}

function formatTelegram(n: NotificationItem): string {
  const d = n.data as Record<string, unknown>;
  const title = typeof d["title"] === "string" ? (d["title"] as string) : n.type;
  const msg = typeof d["message"] === "string" ? (d["message"] as string) : "";
  const card = typeof d["card_title"] === "string" ? ` — ${d["card_title"]}` : "";
  return `${title}${card}\n${msg}`.trim().slice(0, 3500);
}

export interface ForwardTargets {
  telegram?: TelegramTarget;
  prefixes?: string[];
  log?: (msg: string) => void;
}

export interface TelegramTarget {
  botToken: string;
  chatId: string;
}

/** Plain-text Telegram push (no markdown — card titles contain markup chars). */
export async function sendTelegram(botToken: string, chatId: string, text: string): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!res.ok) throw new Error(`telegram sendMessage ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

export interface NotifyResult {
  total: number;
  fresh: number; // unseen, all types
  forwarded: number; // unseen + type-matched (+ sent when a target is set)
}

/**
 * Handle one fresh notification: skip non-matching types, forward matching
 * ones to the Telegram owner chat, or just log when no target is set. A
 * send failure leaves the id unseen so the next pass retries. Returns true
 * when the id was marked seen.
 */
async function processFresh(
  n: NotificationItem,
  seen: Set<string>,
  opts: { telegram?: TelegramTarget; prefixes?: string[]; log: (msg: string) => void },
): Promise<boolean> {
  if (!shouldForward(n, opts.prefixes)) {
    seen.add(n.id);
    return false;
  }
  if (!opts.telegram) {
    const text = formatTelegram(n);
    opts.log(`notify (no target): [${n.type}] ${text.replace(/\n/g, " ")}`);
    seen.add(n.id);
    return true;
  }
  try {
    await sendTelegram(opts.telegram.botToken, opts.telegram.chatId, formatTelegram(n));
  } catch (e) {
    opts.log(`notify telegram failed for ${n.id}, will retry: ${e instanceof Error ? e.message : e}`);
    return false;
  }
  seen.add(n.id);
  return true;
}

/**
 * Single live notification from the realtime feed: same handling as a poll
 * hit, using the shared seen set. Target failures stay unseen so the
 * periodic resync retries them.
 */
export async function handleLiveNotification(n: NotificationItem, opts: ForwardTargets = {}): Promise<void> {
  return seenExclusive(async () => {
    const seen = await loadSeenIds();
    if (seen.has(n.id)) return;
    await processFresh(n, seen, {
      telegram: opts.telegram,
      prefixes: opts.prefixes,
      log: opts.log ?? ((m: string) => console.log(m)),
    });
    await saveSeenIds(seen);
  });
}

/**
 * Single poll: fetch notifications, forward unseen matching ones to each
 * configured target (or just log when none), then mark them seen. Target
 * failures keep the id unseen so the next poll retries.
 */
export async function checkNotifications(session: WikiSession, opts: ForwardTargets = {}): Promise<NotifyResult> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const notifications = await getMyNotifications(session);
  // Fresh-only by default: on first run (no seen file yet), seed the baseline
  // without forwarding so the backlog isn't flushed to Telegram.
  if (!(await Bun.file(SEEN_NOTIFICATIONS_FILE).exists())) {
    await saveSeenIds(new Set(notifications.map((n) => n.id)));
    log(`notify: seeded baseline (${notifications.length} existing, 0 forwarded)`);
    return { total: notifications.length, fresh: 0, forwarded: 0 };
  }
  const seen = await loadSeenIds();
  const fresh = notifications.filter((n) => !seen.has(n.id));
  let forwarded = 0;
  let freshCount = fresh.length;
  await seenExclusive(async () => {
    // Re-check inside the mutex: a live event may have marked ids seen
    // while the fetch above was in flight.
    const current = await loadSeenIds();
    for (const id of current) seen.add(id);
    const todo = fresh.filter((n) => !seen.has(n.id));
    freshCount = todo.length;
    for (const n of todo) {
      if (await processFresh(n, seen, { telegram: opts.telegram, prefixes: opts.prefixes, log })) forwarded++;
    }
    await saveSeenIds(seen);
  });
  return { total: notifications.length, fresh: freshCount, forwarded };
}

// --- Bot-log tee ---------------------------------------------------------------
// Fire-and-forget fan-out of the bot's own log lines (pack opens, claims,
// bids, recycles, settles) to any registered sink (currently the Telegram
// owner chat). Lines are batched per sink (≤maxChars) and sent sequentially
// with a gap to respect rate limits. Drops (with a console note) instead of
// growing unbounded when a sink is down.

interface LogSink {
  name: string;
  maxChars: number;
  gapMs: number;
  send: (text: string) => Promise<void>;
  queue: string[];
  running: boolean;
}

const logSinks: LogSink[] = [];
let sinksPaused = false;

function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Register a log sink. Lines queued via queueLogLine fan out to all sinks. */
export function addLogSink(name: string, maxChars: number, gapMs: number, send: (text: string) => Promise<void>): void {
  logSinks.push({ name, maxChars, gapMs, send, queue: [], running: false });
}

/** Pause/resume delivery (used to avoid double-send while a command's output
 * is captured for an interactive reply). Queued lines flush on resume. */
export function setLogSinksPaused(paused: boolean): void {
  sinksPaused = paused;
  if (!paused) for (const s of logSinks) void pumpLogSink(s);
}

async function pumpLogSink(s: LogSink): Promise<void> {
  if (s.running) return;
  s.running = true;
  try {
    while (s.queue.length > 0 && !sinksPaused) {
      let msg = "";
      while (s.queue.length > 0 && (msg + s.queue[0]! + "\n").length <= s.maxChars) {
        msg += `${s.queue.shift()!}\n`;
      }
      if (!msg) msg = `${s.queue.shift()!}\n`.slice(0, s.maxChars);
      try {
        await s.send(msg.trim());
      } catch (e) {
        console.error(`${s.name} log tee failed, dropping message: ${e instanceof Error ? e.message : e}`);
      }
      if (s.queue.length > 0) await sleepMs(s.gapMs);
    }
  } finally {
    s.running = false;
  }
}

/** Queue one bot log line for all sinks. No-op unless a sink was added. */
export function queueLogLine(line: string): void {
  for (const s of logSinks) {
    if (s.queue.length >= 100) {
      s.queue.shift(); // shed oldest under sustained failure
    }
    s.queue.push(line);
    void pumpLogSink(s);
  }
}
