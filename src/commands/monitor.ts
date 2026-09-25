// Monitor commands: watch (one-shot snapshot) and notify (live realtime feed
// + periodic resync safety net).
import { env } from "../config.ts";
import { ensureSession } from "../wikimasters/session.ts";
import { getProDailyStatus, getSpecialPacks } from "../wikimasters/api.ts";
import type { NotificationItem } from "../wikimasters/types.ts";
import { log } from "../core.ts";
import { jitteredSleep } from "../wikimasters/stealth.ts";
import { checkNotifications, handleLiveNotification } from "../bot/notify.ts";
import { RealtimeManager, subscribeNotifications } from "../wikimasters/realtime.ts";
import { WikiClient } from "../wikimasters/client.ts";
import { getMyMarketBuckets, getMyNotifications, getMyTrades } from "../wikimasters/supabase.ts";

export async function cmdWatch(): Promise<void> {
  const s = await ensureSession();
  const [n, t, m, sp, pro] = await Promise.all([
    getMyNotifications(s)
      .then((notifications) => ({ notifications }))
      .catch((e) => ({ error: String(e) })),
    getMyTrades(s, true)
      .then((trades) => ({ trades }))
      .catch((e) => ({ error: String(e) })),
    getMyMarketBuckets(s).catch((e) => ({ error: String(e) })),
    getSpecialPacks(s).catch((e) => ({ error: String(e) })),
    getProDailyStatus(s).catch((e) => ({ error: String(e) })),
  ]);
  // Via log() (not console) so the Telegram bot can capture it as a reply.
  for (const line of JSON.stringify({ notifications: n, trades: t, marketplace: m, special: sp, proDaily: pro }, null, 2).slice(0, 4000).split("\n")) log(line);
}

export async function cmdNotify(once: boolean, intervalS: number): Promise<void> {
  // Telegram owner push: same opt-in as background log pushes.
  const tgToken = env("TELEGRAM_BOT_TOKEN");
  const tgOwner = env("TELEGRAM_OWNER_ID");
  const telegram =
    tgToken && tgOwner && env("TELEGRAM_LOGS") === "1" ? { botToken: tgToken, chatId: tgOwner } : undefined;
  if (!telegram) log("no Telegram target set (needs TELEGRAM_BOT_TOKEN + TELEGRAM_OWNER_ID + TELEGRAM_LOGS=1) — events will only log");
  if (once) {
    const s = await ensureSession();
    const r = await checkNotifications(s, { telegram, log });
    log(`notify: ${r.total} total, ${r.fresh} fresh, ${r.forwarded} forwarded`);
    return;
  }
  // Live mode: realtime INSERT events + periodic resync safety net (missed
  // events, target failures, socket drops). Reconnects on any failure.
  const resyncS = Math.max(15, intervalS);
  for (;;) {
    try {
      await runNotifyLive(telegram, resyncS);
    } catch (e) {
      log(`notify live failed, reconnecting in 30s: ${e instanceof Error ? e.message : e}`);
      await jitteredSleep(30_000, 0.2);
    }
  }
}

/** Interruptible sleep for the live loop — a stop request lands within ~5s. */
async function sleepStoppable(ms: number, shouldStop: () => boolean): Promise<boolean> {
  let left = ms;
  while (left > 0) {
    if (shouldStop()) return false;
    await new Promise((r) => setTimeout(r, Math.min(left, 5000)));
    left -= 5000;
  }
  return !shouldStop();
}

/** Connects the realtime feed. Returns when shouldStop() is true (graceful);
 * throws when the connection must be re-established by the caller.
 * Always closes the socket before returning/throwing. */
export async function runNotifyLive(
  telegram: { botToken: string; chatId: string } | undefined,
  resyncS: number,
  shouldStop: () => boolean = () => false,
): Promise<void> {
  const onInsert = (n: NotificationItem): void => {
    void handleLiveNotification(n, { telegram, log }).catch((e) =>
      log(`notify live handler failed: ${e instanceof Error ? e.message : e}`),
    );
  };
  const client = await WikiClient.boot();
  let s = await client.session();
  const userId = s.user.id;
  if (!telegram) log("notify: live with no Telegram target (needs TELEGRAM_BOT_TOKEN + TELEGRAM_OWNER_ID + TELEGRAM_LOGS=1) — events will only log");
  // Baseline + backlog flush, same as one poll.
  const r = await checkNotifications(s, { telegram, log });
  log(`notify: live baseline (${r.total} total, ${r.fresh} fresh, ${r.forwarded} forwarded), resync every ${resyncS}s`);
  const mgr = await RealtimeManager.connect(s);
  try {
    await mgr.add((sb) => subscribeNotifications(sb, userId, onInsert));
    log("notify: realtime subscribed");
    let token = client.token;
    let lastResync = Date.now();
    for (;;) {
      if (!(await sleepStoppable(30_000, shouldStop))) return;
      s = await client.session();
      if (s.access_token !== token) {
        // Token rotated: fresh socket + resubscribe via the tracked factories.
        log("notify: session rotated, reconnecting realtime");
        await mgr.reconnect(s);
        token = client.token;
        lastResync = Date.now();
        continue;
      }
      if (Date.now() - lastResync >= resyncS * 1000) {
        try {
          const r2 = await checkNotifications(s, { telegram, log });
          if (r2.forwarded > 0) log(`notify: resync forwarded ${r2.forwarded}/${r2.fresh} fresh`);
        } catch (e) {
          log(`notify resync failed: ${e instanceof Error ? e.message : e}`);
        }
        lastResync = Date.now();
      }
    }
  } finally {
    await mgr.close();
  }
}
