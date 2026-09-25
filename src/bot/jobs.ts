// Background job supervisor: a single `auto` job (verify + claim + settle +
// pack opening, regen-aware sleeps) driven by loopTick(), plus the notify
// live feed (realtime notifications + resync safety net) which runs exactly
// while auto runs. Manual start/stop only — everything is stopped on
// (re)start. Ticks run through the shared runExclusive mutex so they never
// interleave with Telegram commands.
import { loopTick, type LoopTickState } from "../commands/packs.ts";
import { runNotifyLive } from "../commands/monitor.ts";
import { env } from "../config.ts";
import { log, runExclusive } from "../core.ts";

export interface AutoStatus {
  running: boolean;
  startedAt: string | null;
  lastRunAt: string | null;
  lastOutcome: string;
  ticks: number;
  opened: number;
  failures: number;
  notifyLive: boolean;
  notifyOutcome: string;
}

const MAX_FAILURES = 5;
const STOP_SLICE_MS = 5000;

export class AutoJob {
  private running = false;
  private stopRequested = false;
  private startedAt: string | null = null;
  private lastRunAt: string | null = null;
  private lastOutcome = "never ran";
  private ticks = 0;
  private opened = 0;
  private failures = 0;
  private state: LoopTickState = { opened: 0, maxOpens: 0 };

  status(): AutoStatus {
    return {
      running: this.running,
      startedAt: this.startedAt,
      lastRunAt: this.lastRunAt,
      lastOutcome: this.lastOutcome,
      ticks: this.ticks,
      opened: this.opened,
      failures: this.failures,
      notifyLive: notifyLiveJob.isRunning,
      notifyOutcome: notifyLiveJob.outcome,
    };
  }

  start(): string {
    if (this.running) return `already running (started ${this.startedAt}, ${this.ticks} ticks, opened ${this.opened})`;
    this.running = true;
    this.stopRequested = false;
    this.startedAt = new Date().toISOString();
    this.failures = 0;
    this.lastOutcome = "started";
    log("auto: started (verify + claim + settle + open, regen-aware)");
    void this.loop().catch((e) => {
      this.running = false;
      log(`auto: crashed: ${e instanceof Error ? e.message : e}`);
    });
    const notifyMsg = notifyLiveJob.start();
    return `auto job started (${notifyMsg})`;
  }

  stop(): string {
    notifyLiveJob.stop();
    if (!this.running) return "auto job is not running";
    this.stopRequested = true;
    return "stopping auto job + notify live (finishes current tick)…";
  }

  /** Interruptible sleep — wakes early when stop is requested. Returns false if stopped. */
  private async sleepInterruptible(ms: number): Promise<boolean> {
    let left = ms;
    while (left > 0) {
      if (this.stopRequested) return false;
      await new Promise((r) => setTimeout(r, Math.min(left, STOP_SLICE_MS)));
      left -= STOP_SLICE_MS;
    }
    return !this.stopRequested;
  }

  private async loop(): Promise<void> {
    while (!this.stopRequested) {
      try {
        const openedBefore = this.state.opened;
        const t = await runExclusive("auto-tick", () => loopTick(this.state));
        this.ticks++;
        this.lastRunAt = new Date().toISOString();
        const openedNow = this.state.opened - openedBefore;
        this.opened = this.state.opened;
        this.failures = 0;
        this.lastOutcome =
          openedNow > 0 ? `opened ${openedNow} pack(s) (total ${this.opened})` : `tick ${this.ticks}: nothing to open, waiting`;
        if (t.stop) {
          this.lastOutcome = "stopped (max-opens not used by auto job — this should not happen)";
          break;
        }
        // Quiet ticks stay quiet (no sink spam every 10 min); notable ones log.
        if (openedNow > 0) log(`auto: ${this.lastOutcome}`);
        if (!(await this.sleepInterruptible(t.sleepMs))) break;
      } catch (e) {
        this.failures++;
        this.lastOutcome = `error: ${e instanceof Error ? e.message : e} (${this.failures}/${MAX_FAILURES})`;
        log(`auto: ${this.lastOutcome}`);
        if (this.failures >= MAX_FAILURES) {
          log("auto: too many failures, stopping");
          break;
        }
        if (!(await this.sleepInterruptible(60_000))) break;
      }
    }
    this.running = false;
    this.stopRequested = false;
    notifyLiveJob.stop(); // paired lifecycle: notify runs exactly while auto runs
    log("auto: stopped");
  }
}

// --- Notify live -----------------------------------------------------------
// Realtime notifications feed + periodic resync safety net, same behavior as
// `notify` live mode. Owned by the auto job: started by AutoJob.start(),
// stopped when auto stops (or crashes past MAX_FAILURES).

function notifyTarget(): { botToken: string; chatId: string } | undefined {
  const tgToken = env("TELEGRAM_BOT_TOKEN");
  const tgOwner = env("TELEGRAM_OWNER_ID");
  return tgToken && tgOwner && env("TELEGRAM_LOGS") === "1" ? { botToken: tgToken, chatId: tgOwner } : undefined;
}

class NotifyLiveJob {
  private running = false;
  private stopRequested = false;
  private lastOutcome = "never ran";

  get isRunning(): boolean {
    return this.running;
  }

  get outcome(): string {
    return this.lastOutcome;
  }

  start(resyncS = 60): string {
    if (this.running) return `notify live already running (${this.lastOutcome})`;
    this.running = true;
    this.stopRequested = false;
    this.lastOutcome = "started";
    log("notify live: started (realtime feed + resync safety net)");
    void this.loop(resyncS).catch((e) => {
      this.running = false;
      log(`notify live: crashed: ${e instanceof Error ? e.message : e}`);
    });
    return "notify live started";
  }

  stop(): void {
    this.stopRequested = true;
  }

  /** Interruptible sleep — wakes early when stop is requested. Returns false if stopped. */
  private async sleepInterruptible(ms: number): Promise<boolean> {
    let left = ms;
    while (left > 0) {
      if (this.stopRequested) return false;
      await new Promise((r) => setTimeout(r, Math.min(left, STOP_SLICE_MS)));
      left -= STOP_SLICE_MS;
    }
    return !this.stopRequested;
  }

  private async loop(resyncS: number): Promise<void> {
    while (!this.stopRequested) {
      try {
        await runNotifyLive(notifyTarget(), resyncS, () => this.stopRequested);
      } catch (e) {
        if (this.stopRequested) break;
        this.lastOutcome = `error: ${e instanceof Error ? e.message : e} — reconnecting`;
        log(`notify live failed, reconnecting in 30s: ${e instanceof Error ? e.message : e}`);
        if (!(await this.sleepInterruptible(30_000))) break;
        continue;
      }
      break; // graceful stop (runNotifyLive returned via shouldStop)
    }
    this.running = false;
    this.stopRequested = false;
    this.lastOutcome = "stopped";
    log("notify live: stopped");
  }
}

export const notifyLiveJob = new NotifyLiveJob();

// Single shared instance (telegram commands delegate to these functions,
// unchanged from the module-singleton days).
export const autoJob = new AutoJob();

export function getAutoStatus(): AutoStatus {
  return autoJob.status();
}

export function startAuto(): string {
  return autoJob.start();
}

export function stopAuto(): string {
  return autoJob.stop();
}
