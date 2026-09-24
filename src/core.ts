// Shared runtime: timestamped log fan-out, log capture for bot replies,
// async mutex, sleep, card formatting. Imported by commands, jobs and the
// Telegram bot — never imports them (no cycles).
import { queueLogLine } from "./notify.ts";
import type { PackCard } from "./types.ts";

let logBuffer: string[] | null = null;

export function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  queueLogLine(line);
  if (logBuffer) logBuffer.push(line);
}

/**
 * Run fn with log() output captured. Used by the Telegram bot to reply with
 * command output. Returns the result plus captured lines (also still printed
 * and fanned out to log sinks — callers pause sinks around this if needed).
 */
export async function captureLogs<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const prev = logBuffer;
  logBuffer = [];
  try {
    const result = await fn();
    const lines = logBuffer ?? [];
    logBuffer = prev;
    if (prev) prev.push(...lines);
    return { result, lines };
  } catch (e) {
    const lines = logBuffer ?? [];
    logBuffer = prev;
    if (prev) prev.push(...lines);
    throw e;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Serialize async work that shares the module-level log-capture buffer
 * (Telegram commands, job ticks). Prevents overlapping executions from
 * clobbering each other's captured reply lines.
 */
let exclusiveTail: Promise<void> = Promise.resolve();

export function runExclusive<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const run = exclusiveTail.then(async () => {
    console.log(`[exclusive] ${label}`);
    return fn();
  });
  exclusiveTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function fmtCard(c: PackCard): string {
  return `${c.rarity} ${c.wikipedia_title} (atk ${c.atk} / def ${c.def} / views ${c.pageviews})`;
}
