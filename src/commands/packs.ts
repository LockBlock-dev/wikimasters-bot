// Pack commands: status, open, claim, loop.
import { MAX_PACKS, PACK_REGEN_MS, PACK_REGEN_PRO_MS } from "../config.ts";
import { ensureSession } from "../session.ts";
import {
  claimGracePack,
  claimProDaily,
  claimSpecialPack,
  getCollectionStats,
  getProDailyStatus,
  getProfile,
  getSpecialPacks,
  needsHumanVerify,
  openPack,
  verifyHuman,
} from "../api.ts";
import type { Profile, WikiSession } from "../types.ts";
import { fmtCard, log, sleep } from "../core.ts";
import { humanDelay, jitter } from "../stealth.ts";
import { cmdSettle } from "./market.ts";

export async function cmdStatus(): Promise<void> {
  const s = await ensureSession();
  const p = await getProfile(s);
  log(`user ${p.username} (pro=${p.is_pro} vip=${p.is_vip}) packs=${p.packs_remaining}/${MAX_PACKS} balance=${p.wikibidous_balance}`);
  log(`regen_at=${p.packs_last_regen_at} verified_at=${p.pack_human_verified_at} blocked_until=${p.activity_blocked_until}`);
  try {
    const stats = await getCollectionStats(s);
    log(`collection total=${stats.total} ${JSON.stringify(stats.rarityCounts)}`);
  } catch (e) {
    log(`collection stats failed: ${e instanceof Error ? e.message : e}`);
  }
  try {
    const [pro, sp] = await Promise.all([getProDailyStatus(s), getSpecialPacks(s)]);
    log(`pro-daily eligible=${pro.eligible} claimed_today=${pro.claimed_today} special available=${sp.available} packs=${sp.packs.length}`);
  } catch (e) {
    log(`pack status failed: ${e instanceof Error ? e.message : e}`);
  }
}

export async function cmdOpen(): Promise<void> {
  let s = await ensureSession();
  let p = await getProfile(s);
  if (p.activity_blocked_until && new Date(p.activity_blocked_until).getTime() > Date.now()) {
    throw new Error(`account blocked until ${p.activity_blocked_until}`);
  }
  if (needsHumanVerify(p)) {
    log("human verification expired, verifying...");
    const v = await verifyHuman(s);
    log(`verified at ${v.pack_human_verified_at}`);
    p = await getProfile(s);
  }
  if (p.packs_remaining <= 0) {
    log(`no packs left. next regen ~ ${p.packs_last_regen_at}`);
    return;
  }
  // The site plays a 600ms rip animation before revealing; mirror a human pause.
  await humanDelay(700, 2200);
  try {
    const r = await openPack(s);
    log(`opened pack: ${r.packs_remaining} left`);
    for (const c of r.cards) log(`  - ${fmtCard(c)}`);
  } catch (e) {
    const data = (e as { data?: { human_verification_required?: boolean } }).data;
    if (data?.human_verification_required) {
      log("server requires human verification, verifying + retry once...");
      await verifyHuman(s);
      const r = await openPack(s);
      log(`opened pack: ${r.packs_remaining} left`);
      for (const c of r.cards) log(`  - ${fmtCard(c)}`);
      return;
    }
    throw e;
  }
}

export async function cmdClaim(profile?: Profile): Promise<void> {
  const s = await ensureSession();
  // Pro daily: only POST when GET says eligible (POST 403s for non-PRO).
  try {
    const st = await getProDailyStatus(s);
    log(`pro-daily eligible=${st.eligible} claimed_today=${st.claimed_today} date=${st.claim_date}`);
    if (st.eligible) {
      const r = await claimProDaily(s);
      const cards = r.cards ?? [];
      log(`claimed pro-daily: ${cards.length} cards`);
      for (const c of cards) log(`  - ${fmtCard(c)}`);
    }
  } catch (e) {
    log(`pro-daily claim skipped: ${e instanceof Error ? e.message : e}`);
  }
  // Specials: only POST when GET says available (POST 404s when no event).
  try {
    const sp = await getSpecialPacks(s);
    log(`special available=${sp.available} packs=${sp.packs.length}`);
    if (sp.available) {
      for (const pack of sp.packs) {
        const r = await claimSpecialPack(s, pack.id);
        const cards = r.cards ?? [];
        log(`claimed special${pack.id ? ` ${pack.id}` : ""}: ${cards.length} cards`);
        for (const c of cards) log(`  - ${fmtCard(c)}`);
      }
      if (sp.packs.length === 0) {
        const r = await claimSpecialPack(s);
        const cards = r.cards ?? [];
        log(`claimed special: ${cards.length} cards`);
        for (const c of cards) log(`  - ${fmtCard(c)}`);
      }
    }
  } catch (e) {
    log(`special claim skipped: ${e instanceof Error ? e.message : e}`);
  }
  // Grace (VIP-only): opportunistic, 403 expected for non-VIP.
  // Skip the POST entirely when we already know the account isn't VIP.
  const isVip = profile?.is_vip ?? (await getProfile(s).catch(() => null))?.is_vip;
  if (isVip) {
    try {
      const r = await claimGracePack(s);
      const cards = r.cards ?? [];
      if (cards.length > 0) {
        log(`claimed grace: ${cards.length} cards`);
        for (const c of cards) log(`  - ${fmtCard(c)}`);
      }
    } catch (e) {
      log(`grace claim skipped: ${e instanceof Error ? e.message : e}`);
    }
  }
}

export interface LoopTickState {
  opened: number;
  maxOpens: number;
}

export interface LoopTickResult {
  /** ms the caller should sleep before the next tick (0 = none). */
  sleepMs: number;
  /** true when --max-opens was reached and the loop should stop. */
  stop: boolean;
}

/**
 * One loop iteration: session → block-check → verify → claim → settle →
 * open-if-any → compute wait. The caller (cmdLoop or the Telegram job
 * runner) owns the actual sleeping so it stays interruptible.
 */
export async function loopTick(state: LoopTickState): Promise<LoopTickResult> {
  let s: WikiSession;
  try {
    s = await ensureSession();
  } catch (e) {
    log(`session failed, sleeping 60s: ${e instanceof Error ? e.message : e}`);
    return { sleepMs: 60_000, stop: false };
  }
  let p: Profile;
  try {
    p = await getProfile(s);
  } catch (e) {
    log(`profile sync failed (transient?), sleeping 60s: ${e instanceof Error ? e.message : e}`);
    return { sleepMs: 60_000, stop: false };
  }
  if (p.activity_blocked_until && new Date(p.activity_blocked_until).getTime() > Date.now()) {
    const ms = new Date(p.activity_blocked_until).getTime() - Date.now() + 5000;
    log(`blocked until ${p.activity_blocked_until}, sleeping ${Math.round(ms / 1000)}s`);
    return { sleepMs: ms, stop: false };
  }
  if (needsHumanVerify(p)) {
    try {
      const v = await verifyHuman(s);
      log(`human verified at ${v.pack_human_verified_at}`);
      p = await getProfile(s);
    } catch (e) {
      log(`verify-human failed, sleeping 60s: ${e instanceof Error ? e.message : e}`);
      return { sleepMs: 60_000, stop: false };
    }
  }
  // Free claims first (pro-daily / special / grace) — no spend.
  try {
    await cmdClaim(p);
  } catch (e) {
    log(`auto-claim failed: ${e instanceof Error ? e.message : e}`);
  }
  // Collect finished wins (settle transfers card/funds, no spend).
  try {
    const n = await cmdSettle();
    if (n > 0) log(`auto-settled ${n} win(s)`);
  } catch (e) {
    log(`auto-settle failed: ${e instanceof Error ? e.message : e}`);
  }
  if (p.packs_remaining > 0) {
    await cmdOpen();
    state.opened++;
    if (state.maxOpens > 0 && state.opened >= state.maxOpens) {
      log(`reached --max-opens ${state.maxOpens}, stopping`);
      return { sleepMs: 0, stop: true };
    }
    return { sleepMs: jitter(5000, 0.4), stop: false };
  }
  const period = p.is_pro ? PACK_REGEN_PRO_MS : PACK_REGEN_MS;
  const regenAt = p.packs_last_regen_at ? new Date(p.packs_last_regen_at).getTime() + period : Date.now() + period;
  const waitMs = Math.max(30_000, regenAt - Date.now() + 2000);
  log(`0 packs. next regen ~ ${new Date(regenAt).toISOString()} (in ${Math.round(waitMs / 1000)}s). sleeping...`);
  return { sleepMs: Math.min(waitMs, 15 * 60_000), stop: false };
}

export async function cmdLoop(maxOpens: number): Promise<void> {
  const state: LoopTickState = { opened: 0, maxOpens };
  for (;;) {
    const t = await loopTick(state);
    if (t.stop) return;
    await sleep(t.sleepMs);
  }
}
