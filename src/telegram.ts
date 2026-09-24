// Telegram control bot: run bot commands from chat + receive log pushes.
// Owner-gated — every update from anyone else is dropped and logged.
// Dangerous commands preview first, then execute only via inline Confirm,
// using the frozen IDs/decisions from the preview (bid decisions are
// revalidated against live prices at confirm time).
import { Bot, Context, InlineKeyboard } from "grammy";
import { env } from "./config.ts";
import { addLogSink, setLogSinksPaused } from "./notify.ts";
import { captureLogs, runExclusive } from "./core.ts";
import { cmdClaim, cmdOpen, cmdStatus } from "./commands/packs.ts";
import { cmdBid, cmdSettle, cmdTop, type BidDecision, type BidOpts } from "./commands/market.ts";
import { cmdRecycle, cmdWishlistClean } from "./commands/collection.ts";
import { cmdNotify, cmdWatch } from "./commands/monitor.ts";
import { getAutoStatus, startAuto, stopAuto } from "./jobs.ts";

const TG_CHUNK = 4000;
const CONFIRM_TTL_MS = 10 * 60_000;

type Pending =
  | { kind: "recycle"; ids: string[]; createdAt: number }
  | { kind: "wishlist"; ids: string[]; createdAt: number }
  | { kind: "bid"; opts: BidOpts; decisions: BidDecision[]; createdAt: number };

const pending = new Map<string, Pending>();
let pendingSeq = 0;

function chunked(lines: string[]): string[] {
  const out: string[] = [];
  let cur = "";
  const push = (s: string): void => {
    const t = s.trim();
    if (t) out.push(t);
  };
  for (let line of lines) {
    if ((cur + line + "\n").length <= TG_CHUNK) {
      cur += `${line}\n`;
      continue;
    }
    push(cur);
    cur = "";
    // Hard-split single lines longer than the limit (e.g. /watch JSON blob).
    while (line.length > TG_CHUNK) {
      push(line.slice(0, TG_CHUNK));
      line = line.slice(TG_CHUNK);
    }
    if (line) cur = `${line}\n`;
  }
  push(cur);
  return out.length > 0 ? out : ["(no output)"];
}

function parseNum(raw: string | undefined, def: number): number {
  if (raw == null || raw.trim() === "") return def;
  const n = Number(raw);
  return Number.isFinite(n) ? n : def;
}

function parseBidArgs(text: string): BidOpts {
  const args = Object.fromEntries(
    text
      .split(/\s+/)
      .slice(1)
      .map((t) => t.split("="))
      .filter((p) => p.length === 2)
      .map(([k, v]) => [k!.toLowerCase(), v!]),
  );
  const sort = args["sort"] === "ending_soon" ? "ending_soon" : "recent";
  return {
    yes: false,
    maxPrice: parseNum(args["max_price"], 50),
    factor: parseNum(args["factor"], 0.7),
    minSecs: parseNum(args["min_secs"], 120),
    maxTotal: parseNum(args["max_total"], 100),
    limit: Math.min(parseNum(args["limit"], 30), 100),
    sort,
  };
}

/** Run fn with log sinks paused, reply with captured lines. */
async function replyCaptured(reply: (text: string) => Promise<unknown>, fn: () => Promise<unknown>): Promise<string[]> {
  setLogSinksPaused(true);
  try {
    const { lines } = await captureLogs(fn);
    for (const c of chunked(lines)) await reply(c);
    return lines;
  } catch (e) {
    await reply(`error: ${e instanceof Error ? e.message : e}`);
    return [];
  } finally {
    setLogSinksPaused(false);
  }
}

export async function startTelegramBot(): Promise<void> {
  const token = env("TELEGRAM_BOT_TOKEN");
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN missing — talk to @BotFather, then add it to .env");
  const ownerId = env("TELEGRAM_OWNER_ID");
  if (!ownerId) throw new Error("TELEGRAM_OWNER_ID missing — message @userinfobot, then add your numeric id to .env");

  const bot = new Bot(token);

  // Hard clamp: Telegram rejects >4096 chars. Slice EVERY outbound message
  // here so no call site can ever trip "message is too long" again.
  // (ctx.reply, ctx.editMessageText captions, etc. all funnel through sendMessage.)
  const rawSendMessage = bot.api.sendMessage.bind(bot.api);
  bot.api.sendMessage = (async (chat_id: number | string, text: string, other?: Record<string, unknown>) => {
    const parts: string[] = [];
    let rest = text;
    while (rest.length > TG_CHUNK) {
      parts.push(rest.slice(0, TG_CHUNK));
      rest = rest.slice(TG_CHUNK);
    }
    parts.push(rest);
    let last: unknown;
    for (let i = 0; i < parts.length; i++) {
      try {
        last = await rawSendMessage(chat_id as number, parts[i]!, (i === 0 ? other : undefined) as never);
      } catch (e) {
        console.error(
          `telegram: send failed part ${i + 1}/${parts.length} len=${parts[i]!.length}:`,
          e instanceof Error ? e.message : e,
        );
        throw e;
      }
    }
    return last;
  }) as typeof bot.api.sendMessage;

  // Global trap: log which update blew up, instead of a bare error line.
  bot.catch((err) => {
    console.error(
      `telegram: unhandled error on update ${err.ctx?.update?.update_id ?? "?"}:`,
      err.error instanceof Error ? err.error.message : err.error,
    );
  });

  // Owner gate: drop everything from strangers (incl. callbacks/unknown input).
  bot.use(async (ctx, next) => {
    if (String(ctx.from?.id) !== ownerId) {
      console.log(`telegram: dropped update from ${ctx.from?.id} (${ctx.from?.username ?? "?"})`);
      return;
    }
    await next();
  });

  type Ctx = Context;

  // All handlers share the runExclusive mutex (index.ts) because they share
  // the module-level log-capture buffer — overlapping runs used to clobber
  // each other's replies (empty "(no output)"). Inner flows already catch and
  // reply their own errors; the .catch here is a backstop for anything earlier.
  function ex(ctx: Ctx, label: string, fn: () => Promise<unknown>): void {
    void runExclusive(`tg:${label}`, fn).catch((e) => ctx.reply(`error: ${e instanceof Error ? e.message : e}`));
  }

  /** Single dispatcher for slash commands and menu buttons (no duplication). */
  async function dispatch(ctx: Ctx, name: string, argText: string): Promise<void> {
    const send = (t: string) => ctx.reply(t);
    switch (name) {
      case "status":
        await replyCaptured(send, () => cmdStatus());
        break;
      case "watch":
        await replyCaptured(send, () => cmdWatch());
        break;
      case "claim":
        await replyCaptured(send, () => cmdClaim());
        break;
      case "open":
        await replyCaptured(send, () => cmdOpen());
        break;
      case "notify":
        await replyCaptured(send, () => cmdNotify(true, 60));
        break;
      case "settle": {
        const n = await cmdSettle();
        await send(n === 0 ? "settle: nothing to settle" : `settled ${n} win(s)`);
        break;
      }
      case "top":
        await replyCaptured(send, () => cmdTop(parseNum(argText, 10), ["C", "PC"]));
        break;
      case "recycle": {
        const limit = Math.min(parseNum(argText || undefined, 200), 500);
        await previewDangerous(
          ctx,
          async () => ({ ...(await previewIds(ctx, "recycle", () => cmdRecycle(false, limit))), kind: "recycle" as const }),
          "Discard the frozen list above? Starred cards were never included.",
        );
        break;
      }
      case "wishlist_clean":
        await previewDangerous(
          ctx,
          async () => ({ ...(await previewIds(ctx, "wishlist", () => cmdWishlistClean(false))), kind: "wishlist" as const }),
          "Remove the frozen list above from the wishlist? (reversible)",
        );
        break;
      case "bid": {
        const opts = parseBidArgs(`/bid ${argText}`);
        await previewDangerous(
          ctx,
          async () => {
            const { result: decisions, lines } = await captureLogs(() => cmdBid({ ...opts }));
            for (const c of chunked(lines)) await send(c);
            return { kind: "bid" as const, opts: { ...opts, yes: true }, decisions };
          },
          "Place these bids? Prices revalidate at confirm; moved markets are skipped.",
        );
        break;
      }
      case "auto_start":
        await send(startAuto());
        break;
      case "auto_stop":
        await send(stopAuto());
        break;
      case "auto_status":
        await send(autoStatusText());
        break;
      default:
        await send(`unknown command: ${name}`);
        break;
    }
  }

  function autoStatusText(): string {
    const a = getAutoStatus();
    return [
      `auto job: ${a.running ? "🟢 running" : "🔴 stopped"}`,
      `started: ${a.startedAt ?? "—"}`,
      `last run: ${a.lastRunAt ?? "—"}`,
      `last outcome: ${a.lastOutcome}`,
      `ticks: ${a.ticks} | opened: ${a.opened} | failures: ${a.failures}`,
    ].join("\n");
  }

  bot.command("start", (ctx) => ctx.reply("wikimasters-bot. /help for commands."));
  bot.command("help", (ctx) =>
    ctx.reply(
      [
        "read-only: /status /watch /top [n] /claim /notify",
        "dangerous (preview + Confirm): /recycle [limit] /bid [k=v…] /wishlist_clean",
        "direct: /settle",
        "bid args: max_price factor min_secs max_total limit sort=recent|ending_soon",
      ].join("\n"),
    ),
  );

  for (const name of ["status", "watch", "claim", "open", "notify", "settle", "recycle", "wishlist_clean", "bid", "top"] as const) {
    bot.command(name, (ctx) => ex(ctx, name, () => dispatch(ctx, name, ctx.match)));
  }
  for (const name of ["auto_start", "auto_stop", "auto_status"] as const) {
    bot.command(name, (ctx) => ex(ctx, name, () => dispatch(ctx, name, "")));
  }

  // Emoji slash-menu (Telegram "/" popup). Retried — boot-time network flaps.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await bot.api.setMyCommands([
    { command: "menu", description: "🧭 button menu" },
    { command: "status", description: "📊 profile, packs, collection" },
    { command: "open", description: "🎁 open one pack now" },
    { command: "claim", description: "🗳 claim free packs" },
    { command: "watch", description: "👀 notifications snapshot" },
    { command: "notify", description: "🔔 poll notifications once" },
    { command: "top", description: "🏆 top unstarred by value" },
    { command: "settle", description: "✅ settle finished wins" },
    { command: "recycle", description: "♻️ discard unstarred C (confirm)" },
    { command: "bid", description: "💰 auto-bid deals (confirm)" },
    { command: "wishlist_clean", description: "🧹 drop owned wishlist (confirm)" },
    { command: "auto_start", description: "🤖 start auto job" },
    { command: "auto_stop", description: "🛑 stop auto job" },
    { command: "auto_status", description: "📟 auto job status" },
    { command: "help", description: "❓ help" },
  ]);
      console.log("telegram: slash-menu registered");
      break;
    } catch (e) {
      console.log(`telegram: setMyCommands attempt ${attempt}/3 failed: ${e instanceof Error ? e.message : e}`);
      if (attempt < 3) await new Promise((r) => setTimeout(r, 3000));
    }
  }

  // Button menu with submenus (Telegram has no nested slash-menus).
  const MENUS: Record<string, { text: string; buttons: Array<{ label: string; data: string }> }> = {
    main: {
      text: "🧭 WikiMasters menu",
      buttons: [
        { label: "🎁 Packs", data: "menu:packs" },
        { label: "💰 Market", data: "menu:market" },
        { label: "🧹 Collection", data: "menu:collection" },
        { label: "🤖 Daemon", data: "menu:daemon" },
      ],
    },
    packs: {
      text: "🎁 Packs",
      buttons: [
        { label: "🎁 Open", data: "run:open" },
        { label: "🗳 Claim", data: "run:claim" },
        { label: "🏆 Top", data: "run:top" },
        { label: "🔙 Back", data: "menu:main" },
      ],
    },
    market: {
      text: "💰 Market",
      buttons: [
        { label: "💰 Bid preview", data: "run:bid" },
        { label: "✅ Settle", data: "run:settle" },
        { label: "🔙 Back", data: "menu:main" },
      ],
    },
    collection: {
      text: "🧹 Collection",
      buttons: [
        { label: "♻️ Recycle preview", data: "run:recycle" },
        { label: "🧹 Wishlist clean", data: "run:wishlist_clean" },
        { label: "🔙 Back", data: "menu:main" },
      ],
    },
    daemon: {
      text: "🤖 Daemon",
      buttons: [
        { label: "🤖 Start", data: "run:auto_start" },
        { label: "🛑 Stop", data: "run:auto_stop" },
        { label: "📟 Status", data: "run:auto_status" },
        { label: "🔙 Back", data: "menu:main" },
      ],
    },
  };

  function menuKeyboard(name: string): InlineKeyboard {
    const kb = new InlineKeyboard();
    const buttons = MENUS[name]?.buttons ?? [];
    for (let i = 0; i < buttons.length; i += 2) {
      const row = buttons.slice(i, i + 2);
      if (row.length === 2) kb.text(row[0]!.label, row[0]!.data).text(row[1]!.label, row[1]!.data);
      else kb.text(row[0]!.label, row[0]!.data);
      if (i + 2 < buttons.length) kb.row();
    }
    return kb;
  }

  bot.command("menu", (ctx) => {
    ex(ctx, "menu", async () => {
      await ctx.reply(MENUS["main"]!.text, { reply_markup: menuKeyboard("main") });
    });
  });

  type PendingDraft =
    | { kind: "recycle"; ids: string[] }
    | { kind: "wishlist"; ids: string[] }
    | { kind: "bid"; opts: BidOpts; decisions: BidDecision[] };

  /** Preview a dangerous command, reply with output + Confirm/Cancel keyboard. */
  async function previewDangerous(ctx: Ctx, entry: () => Promise<PendingDraft>, prompt: string): Promise<void> {
    setLogSinksPaused(true);
    try {
      // entry() runs its own captureLogs internally so the preview lines replay here.
      const p = await entry();
      const count = p.kind === "bid" ? p.decisions.length : p.ids.length;
      if (count === 0) return; // preview already replied "nothing to do"
      const key = `${ctx.chat!.id}:${++pendingSeq}`;
      pending.set(key, { ...p, createdAt: Date.now() } as Pending);
      await ctx.reply(prompt, {
        reply_markup: new InlineKeyboard().text("✅ Confirm", `confirm:${key}`).text("❌ Cancel", `cancel:${key}`),
      });
    } catch (e) {
      await ctx.reply(`error: ${e instanceof Error ? e.message : e}`);
    } finally {
      setLogSinksPaused(false);
    }
  }

  /** Preview that captures + replies lines, then returns ids for the pending store. */
  async function previewIds(
    ctx: Ctx,
    kind: "recycle" | "wishlist",
    run: () => Promise<string[]>,
  ): Promise<{ kind: "recycle" | "wishlist"; ids: string[] }> {
    const { result: ids, lines } = await captureLogs(run);
    for (const c of chunked(lines)) await ctx.reply(c);
    return { kind, ids };
  }

  bot.on("callback_query:data", (ctx) => {
    ex(ctx, "callback", async () => {
      const data = ctx.callbackQuery.data;
      // Keys are "chatId:seq" and contain a colon — rejoin, don't take [1].
      const [kind, ...rest] = data.split(":");
      const arg = rest.join(":");
      // Submenu navigation: edit the same message in place.
      if (kind === "menu" && arg && MENUS[arg]) {
        await ctx.editMessageText(MENUS[arg]!.text, { reply_markup: menuKeyboard(arg) }).catch(() => undefined);
        await ctx.answerCallbackQuery();
        return;
      }
      // Menu leaf buttons: same dispatcher as the slash commands.
      if (kind === "run" && arg) {
        await ctx.answerCallbackQuery("running…");
        await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
        await dispatch(ctx, arg, "");
        return;
      }
      // Confirm/cancel carry the pending key ("chatId:seq" — may contain colons).
      const [action, ...keyParts] = data.split(":");
      const key = keyParts.join(":");
      const p = pending.get(key);
      if (!p || Date.now() - p.createdAt > CONFIRM_TTL_MS) {
        pending.delete(key);
        await ctx.answerCallbackQuery("expired — re-run the preview");
        return;
      }
      if (action === "cancel") {
        pending.delete(key);
        await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
        await ctx.reply("cancelled");
        await ctx.answerCallbackQuery("cancelled");
        return;
      }
      if (action !== "confirm") return;
      pending.delete(key);
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
      await ctx.answerCallbackQuery("executing…");
      setLogSinksPaused(true);
      try {
        if (p.kind === "recycle") {
          const { lines } = await captureLogs(() => cmdRecycle(true, p.ids.length, p.ids));
          for (const c of chunked(lines)) await ctx.reply(c);
        } else if (p.kind === "wishlist") {
          const { lines } = await captureLogs(() => cmdWishlistClean(true, p.ids));
          for (const c of chunked(lines)) await ctx.reply(c);
        } else {
          const { lines } = await captureLogs(() => cmdBid({ ...p.opts, yes: true }, p.decisions));
          for (const c of chunked(lines)) await ctx.reply(c);
        }
      } catch (e) {
        await ctx.reply(`error: ${e instanceof Error ? e.message : e}`);
      } finally {
        setLogSinksPaused(false);
      }
    });
  });

  if (Bun.env["TELEGRAM_LOGS"] === "1") {
    addLogSink("telegram", TG_CHUNK, 700, (text) => bot.api.sendMessage(ownerId, text).then(() => undefined));
  }

  console.log("telegram: polling…");
  await bot.start();
}
