// Background job supervisor: a single `auto` job (verify + claim + settle +
// pack opening, regen-aware sleeps) driven by loopTick(). Manual start/stop
// only — everything is stopped on (re)start. Ticks run through the shared
// runExclusive mutex so they never interleave with Telegram commands.
import { loopTick, type LoopTickState } from "./commands/packs.ts";
import { log, runExclusive } from "./core.ts";

export interface AutoStatus {
  running: boolean;
  startedAt: string | null;
  lastRunAt: string | null;
  lastOutcome: string;
  ticks: number;
  opened: number;
  failures: number;
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
    return "auto job started";
  }

  stop(): string {
    if (!this.running) return "auto job is not running";
    this.stopRequested = true;
    return "stopping auto job (finishes current tick)…";
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
    log("auto: stopped");
  }
}

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
