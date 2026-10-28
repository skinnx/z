/** Channel lifecycle: connect-mode adapters, inbound webhooks and bot dispatch. */
import {
  answerMessage,
  CHANNEL_PREVIEW_CHARS,
  describeError,
  linkCode,
  previewFits,
  type ChannelActivity,
  type ChannelAdapter,
  type ChannelLimits,
  type ChannelOutcome,
  type ChannelRuntime,
  type ChannelSetupStep,
  type ChannelTestResult,
  type ChannelView,
  type InboundMessage,
  type OutboundReply,
} from "@z/core";
import { signedHeaders } from "@z/plugins";
import { approvalBody } from "./notify.ts";
import type { Pairing } from "./owner.ts";
import type { Runtime } from "./runtime.ts";
import type { ChannelRecord } from "./store.ts";
import { ConflictError, type Tasks } from "./tasks.ts";

type Connection = { stop: () => void | Promise<void> };
/** Answers running in a channel, the queue behind them, and a moving average of answer time. */
type Gate = { running: number; queue: (() => void)[]; averageMs: number };
/** One author in one channel: messages in flight, accepted-message times in the last hour. */
type Author = { pending: number; hits: number[]; busyNotified: boolean };
const HOUR = 3600_000;

export type Channels = ReturnType<typeof createChannels>;

type OutboundNotice = Parameters<NonNullable<ChannelAdapter["send"]>>[2];

export function createChannels(rt: Runtime, tasks: Tasks, pairing: Pairing) {
  const { store, bus } = rt;
  const connections = new Map<string, Connection>();
  // Serializes start/stop per channel so rapid config edits don't race.
  const locks = new Map<string, Promise<void>>();

  const adapterFor = (kind: string): ChannelAdapter | undefined => rt.plugins.adapters().find((a) => a.kind === kind);

  const webhookUrl = (record: ChannelRecord) =>
    rt.env.publicUrl && adapterFor(record.kind)?.webhook ? `${rt.env.publicUrl}/hooks/${record.id}` : null;

  // The server's own address, for calls from this machine (a wildcard bind is reached on loopback).
  const host = ["0.0.0.0", "::", ""].includes(rt.env.host) ? "127.0.0.1" : rt.env.host;
  const localBase = `http://${host.includes(":") ? `[${host}]` : host}:${rt.env.port}`;
  const localWebhookUrl = (record: ChannelRecord) => (adapterFor(record.kind)?.webhook ? `${localBase}/hooks/${record.id}` : null);

  function view(record: ChannelRecord): ChannelView {
    const { config: _secret, ...rest } = record;
    return { ...rest, webhookUrl: webhookUrl(record), localWebhookUrl: localWebhookUrl(record) };
  }

  function emit(id: string) {
    const record = store.channels.get(id);
    if (record) bus.emit({ type: "channel", channel: view(record) });
  }

  function setStatus(id: string, status: ChannelRecord["status"], detail: string | null) {
    store.channels.setStatus(id, status, detail);
    emit(id);
  }

  // ─── Bot limits: in memory, per channel and per author (see ChannelLimits) ──
  const gates = new Map<string, Gate>();
  const authors = new Map<string, Author>();
  let sweptAt = Date.now();

  function authorFor(channelId: string, authorId: string): Author {
    const now = Date.now();
    if (now - sweptAt > 10 * 60_000) {
      sweptAt = now;
      for (const [key, a] of authors) if (!a.pending && a.hits.every((t) => now - t >= HOUR)) authors.delete(key);
    }
    const key = `${channelId}\n${authorId}`;
    let author = authors.get(key);
    if (!author) authors.set(key, (author = { pending: 0, hits: [], busyNotified: false }));
    author.hits = author.hits.filter((t) => now - t < HOUR);
    return author;
  }

  /** Minutes until the author may try again, or null when under every cap. */
  function overLimit(gate: Gate, author: Author, limits: ChannelLimits): number | null {
    if (author.hits.length >= limits.authorHourly) return Math.max(1, Math.ceil((author.hits[0]! + HOUR - Date.now()) / 60_000));
    const full = gate.running >= limits.running && gate.queue.length >= limits.waiting;
    if (!full && author.pending < limits.authorWaiting) return null;
    // Roughly how long the queue ahead takes to drain at the recent answer time.
    return Math.max(1, Math.ceil(((gate.queue.length / limits.running + 1) * gate.averageMs) / 60_000));
  }

  // ─── Activity log: the owner's view of what reached each bot ───────────────
  const clip = (text: string) => {
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length > CHANNEL_PREVIEW_CHARS ? `${flat.slice(0, CHANNEL_PREVIEW_CHARS - 1)}…` : flat;
  };

  function logActivity(
    channelId: string,
    outcome: ChannelOutcome,
    entry: { message?: InboundMessage; reply?: OutboundReply | null; started?: number; detail?: string | null } = {},
  ) {
    // Nothing of a message the bot wasn't asked about, or of a request it refused, is kept.
    const kept = outcome !== "ignored" && outcome !== "rejected" ? entry.message : undefined;
    const activity: ChannelActivity = {
      at: new Date().toISOString(),
      outcome,
      author: kept ? clip(kept.author.name) : null,
      // A pairing code is single-use, but still not worth keeping.
      preview: kept ? clip(linkCode(kept.text) !== null ? kept.text.replace(/\d{6}/g, "••••••") : kept.text) : null,
      reply: entry.reply ? clip(entry.reply.text) : null,
      verdict: entry.reply?.verdict ?? null,
      sources: entry.reply?.sources?.length ?? 0,
      ms: entry.started === undefined ? null : Date.now() - entry.started,
      detail: entry.detail ? clip(entry.detail) : null,
      count: 1,
    };
    try {
      store.channelActivity.add(channelId, activity);
      bus.emit({ type: "channelActivity", channelId });
    } catch (error) {
      console.error(`[z] channel ${channelId}: could not log activity: ${describeError(error)}`);
    }
  }

  async function dispatch(channelId: string, message: InboundMessage): Promise<OutboundReply | null> {
    const started = Date.now();
    try {
      const { reply, outcome, detail } = await route(channelId, message);
      if (outcome) logActivity(channelId, outcome, { message, reply, started, detail: detail ?? null });
      return reply;
    } catch (error) {
      logActivity(channelId, "error", { message, started, detail: describeError(error) });
      throw error;
    }
  }

  type Routed = { reply: OutboundReply | null; outcome: ChannelOutcome | null; detail?: string };
  const answered = (reply: OutboundReply | null, message: InboundMessage, always: boolean): Routed => ({
    reply,
    outcome: reply ? "answered" : message.addressed || always ? "silent" : "ignored",
  });

  async function route(channelId: string, message: InboundMessage): Promise<Routed> {
    store.channels.touch(channelId);
    emit(channelId);
    const record = store.channels.get(channelId);
    if (!record?.enabled) return { reply: null, outcome: null };
    // Handled before the model, addressed or not: pairing must not depend on an LLM.
    const code = linkCode(message.text);
    if (code !== null) return { reply: { text: link(record, message, code), replyTo: message.messageId }, outcome: "answered" };
    const owner = store.settings.get().owner;
    const exempt = owner?.channelId === channelId && owner.authorId === message.author.id;
    // Messages the bot won't answer cost nothing, and the owner is never capped.
    if (exempt || !(message.addressed || record.always)) return answered(await answer(record, message), message, record.always);

    let gate = gates.get(channelId);
    if (!gate) gates.set(channelId, (gate = { running: 0, queue: [], averageMs: 30_000 }));
    const author = authorFor(channelId, message.author.id);
    const wait = overLimit(gate, author, record.limits);
    if (wait !== null) {
      const detail = `Over a limit: may try again in ${wait} min`;
      // One reply per stretch over the cap, then quiet until the author is under it again.
      if (author.busyNotified) return { reply: null, outcome: "limited", detail };
      author.busyNotified = true;
      return { reply: { text: `I'm busy right now. Try again in ${wait} min.`, replyTo: message.messageId }, outcome: "limited", detail };
    }
    author.busyNotified = false;
    author.hits.push(Date.now());
    author.pending++;
    try {
      if (gate.running < record.limits.running) gate.running++;
      else await new Promise<void>((resolve) => gate.queue.push(resolve));
      const started = Date.now();
      try {
        return answered(await answer(record, message), message, record.always);
      } finally {
        gate.averageMs = gate.averageMs * 0.8 + (Date.now() - started) * 0.2;
        // Hand the slot straight to the next in line, or free it.
        const next = gate.queue.shift();
        if (next) next();
        else gate.running--;
      }
    } finally {
      author.pending--;
    }
  }

  async function answer(record: ChannelRecord, message: InboundMessage): Promise<OutboundReply | null> {
    const channelId = record.id;
    try {
      const { config: _secret, configured: _c, lastEventAt: _l, status: _s, statusDetail: _d, ...channel } = record;
      const answer = await answerMessage(
        { ...message, channelId },
        { ...rt.deps(`bot:${channelId}`), channel, memory: store.memory.get(channelId, message.threadId) },
      );
      if (!answer) return null;
      store.memory.append(channelId, message.threadId, answer.turns);
      if (record.status === "error") setStatus(channelId, "ok", null);
      return answer.reply;
    } catch (error) {
      setStatus(channelId, "error", `Bot failed: ${describeError(error)}`);
      throw error;
    }
  }

  /** `/link <code>`: make this author in this thread the owner z reaches when away. */
  function link(record: ChannelRecord, message: InboundMessage, code: string): string {
    if (!adapterFor(record.kind)?.send) {
      // The code was just posted somewhere z cannot use privately; void it so nobody else can.
      pairing.revoke(code);
      return `${record.label} can't carry private approvals. That code is now void: pair from Telegram, Discord, Slack or a webhook instead.`;
    }
    if (!pairing.consume(code)) return "That code is wrong or expired. Create a new one in z's Settings.";
    const settings = store.settings.get();
    store.settings.set({
      ...settings,
      owner: { channelId: record.id, threadId: message.threadId, authorId: message.author.id, label: message.author.name },
    });
    return "Paired. z will reach you here for approvals and updates.";
  }

  /** A button press from a channel. Only the paired owner, on the paired channel, may decide or answer. */
  async function act(record: ChannelRecord, actionId: string, from: { threadId: string; authorId: string }): Promise<string> {
    const owner = store.settings.get().owner;
    if (!owner || owner.channelId !== record.id || owner.authorId !== from.authorId) {
      throw new Error("Only z's paired owner can do that.");
    }
    const answer = /^answer:([^:]+):(\d+)$/.exec(actionId);
    if (answer) return answerFromButton(answer[1]!, Number(answer[2]));
    const match = /^(approve|deny):(.+)$/.exec(actionId);
    if (!match) throw new Error("Unknown action.");
    // Approve only what fits here in full; a long action is reviewed in the app (deny is always fine).
    const pending = match[1] === "approve" ? store.approvals.get(match[2]!) : null;
    const limit = adapterFor(record.kind)?.noticeLimit ?? Number.POSITIVE_INFINITY;
    if (pending && !previewFits(approvalBody(pending), limit)) throw new Error("This one is too long to approve here. Open z to review it.");
    try {
      const approval = tasks.decide(match[2]!, { approve: match[1] === "approve", remember: false });
      if (!approval) return "That approval no longer exists.";
      return `${approval.status === "approved" ? "Approved" : "Denied"}: ${approval.summary}`;
    } catch (error) {
      if (error instanceof ConflictError) return `${error.message}.`;
      throw error;
    }
  }

  /** An `ask_person` choice button: the choice text is the answer. */
  function answerFromButton(taskId: string, index: number): string {
    const choice = store.tasks.question(taskId)?.choices[index];
    if (choice === undefined) return "That question was already answered.";
    try {
      const task = tasks.answer(taskId, choice);
      return task ? `Answered: ${choice}` : "That task no longer exists.";
    } catch (error) {
      if (error instanceof ConflictError) return `${error.message}.`;
      throw error;
    }
  }

  function runtimeFor(record: ChannelRecord): ChannelRuntime {
    const { configured: _c, lastEventAt: _l, status: _s, statusDetail: _d, ...channel } = record;
    return {
      channel,
      handle: store.settings.get().handle,
      webhookUrl: webhookUrl(record),
      dispatch: (message) => dispatch(record.id, message),
      act: (actionId, from) => act(record, actionId, from),
      state: {
        get: (key) => store.channelState.get(record.id, key),
        set: (key, value) => store.channelState.set(record.id, key, value),
      },
      deliveries: {
        claim: (deliveryId) => store.deliveries.claim(record.id, deliveryId),
        release: (deliveryId) => void store.deliveries.release(record.id, deliveryId),
      },
      status: (status, detail) => setStatus(record.id, status, detail ?? null),
      note: (outcome, detail) => recordNote(record.id, outcome, detail),
      log: (text) => console.log(`[z:channel:${record.id}] ${text}`),
      fetch,
    };
  }

  function recordNote(channelId: string, outcome: "ignored" | "rejected", detail?: string) {
    logActivity(channelId, outcome, { detail: detail ?? null });
  }

  /** The adapter's next steps, then whether a first message has arrived. */
  async function setupSteps(id: string): Promise<ChannelSetupStep[] | null> {
    const record = store.channels.get(id);
    if (!record) return null;
    const adapter = adapterFor(record.kind);
    if (!adapter) return [{ id: "plugin", label: `Turn on a plugin that provides "${record.kind}"`, status: "error" }];
    let steps: ChannelSetupStep[] = [];
    if (adapter.setup) {
      try {
        steps = await adapter.setup(runtimeFor(record), webhookUrl(record) ?? localWebhookUrl(record) ?? "");
      } catch (error) {
        steps = [{ id: "check", label: "Check the connection", status: "error", detail: describeError(error) }];
      }
    }
    if (!record.enabled) steps.unshift({ id: "enabled", label: "Turn the channel on", status: "todo" });
    const last = store.channelActivity.list(id).find((a) => a.outcome !== "rejected");
    steps.push({
      id: "first",
      label: "Send the bot a first message",
      status: record.lastEventAt ? "done" : "todo",
      ...(last ? { detail: last.at } : {}),
    });
    return steps;
  }

  /** Sign a message with the channel's own secret and run it through `/hooks/:id`, as an integration would. */
  async function testWebhook(id: string, text: string): Promise<ChannelTestResult | null> {
    const record = store.channels.get(id);
    if (!record) return null;
    if (record.kind !== "webhook") throw new Error("Only webhook channels can be tested this way");
    const secret = record.config.secret?.trim();
    if (!secret) throw new Error("The channel has no signing secret");
    const body = JSON.stringify({ text, author: { id: "z-test", name: "Test from z" }, threadId: `z-test-${crypto.randomUUID()}` });
    const url = localWebhookUrl(record)!;
    const started = Date.now();
    const response = await hook(
      id,
      new Request(url, { method: "POST", headers: { "content-type": "application/json", ...signedHeaders(secret, body) }, body }),
    );
    const data = (await response.json().catch(() => ({}))) as {
      reply?: string | null;
      verdict?: ChannelTestResult["verdict"];
      sources?: ChannelTestResult["sources"];
      error?: string;
      retryAfter?: number;
    };
    return {
      status: response.status,
      ms: Date.now() - started,
      reply: data.reply ?? null,
      verdict: data.verdict ?? null,
      sources: data.sources ?? [],
      error: response.ok ? null : (data.error ?? `HTTP ${response.status}`) + (data.retryAfter ? ` (retry in ${data.retryAfter} s)` : ""),
    };
  }

  /** `ALL /hooks/:channelId` (some platforms verify with GET). */
  async function hook(id: string, request: Request): Promise<Response> {
    const record = store.channels.get(id);
    const adapter = record?.enabled ? adapterFor(record.kind) : undefined;
    if (!record || !adapter?.webhook) return Response.json({ error: "Unknown channel" }, { status: 404 });
    try {
      return await adapter.webhook(request, runtimeFor(record));
    } catch (error) {
      setStatus(id, "error", `Webhook failed: ${describeError(error)}`);
      return Response.json({ error: "Webhook handler failed" }, { status: 500 });
    }
  }

  async function stopConnection(id: string) {
    const connection = connections.get(id);
    connections.delete(id);
    if (!connection) return;
    try {
      await connection.stop();
    } catch (error) {
      console.error(`[z] stopping channel ${id} failed: ${describeError(error)}`);
    }
  }

  async function syncNow(id: string) {
    await stopConnection(id);
    const record = store.channels.get(id);
    if (!record) return;
    if (!record.enabled) return setStatus(id, "idle", "Disabled");

    const adapter = adapterFor(record.kind);
    if (!adapter) return setStatus(id, "error", `No enabled plugin provides a "${record.kind}" adapter`);
    if (!adapter.start) {
      if (!webhookUrl(record)) return setStatus(id, "idle", "Set Z_PUBLIC_URL so the platform can reach /hooks");
      if (record.status !== "ok") setStatus(id, "idle", "Waiting for the first webhook");
      return;
    }

    try {
      const stop = await adapter.start(runtimeFor(record));
      connections.set(id, { stop });
      if (store.channels.get(id)?.status !== "error") setStatus(id, "ok", "Connected");
    } catch (error) {
      setStatus(id, "error", `Could not connect: ${describeError(error)}`);
    }
  }

  function sync(id: string): Promise<void> {
    const next = (locks.get(id) ?? Promise.resolve()).then(() => syncNow(id));
    locks.set(id, next.catch(() => {}));
    return next;
  }

  return {
    view,
    sync,
    syncAll: () => Promise.all(store.channels.list().map((c) => sync(c.id))),
    /** Whether the platform must call us (webhook-only adapter), so the channel needs Z_PUBLIC_URL. */
    needsPublicUrl: (kind: string) => {
      const adapter = adapterFor(kind);
      return Boolean(adapter?.webhook && !adapter.start);
    },

    async remove(id: string): Promise<boolean> {
      await (locks.get(id) ?? Promise.resolve());
      await stopConnection(id);
      const settings = store.settings.get();
      if (settings.owner?.channelId === id) store.settings.set({ ...settings, owner: null });
      return store.channels.delete(id);
    },

    /** Longest notice with buttons the channel delivers whole (Infinity when its adapter has no limit). */
    noticeLimit(id: string): number {
      const record = store.channels.get(id);
      return (record && adapterFor(record.kind)?.noticeLimit) || Number.POSITIVE_INFINITY;
    },

    /**
     * Unprompted message to a thread (owner notices). Throws when the channel cannot send.
     * Resolves to the platform's message ref when the adapter can edit it later.
     */
    async send(id: string, threadId: string, message: OutboundNotice): Promise<string | null> {
      const record = store.channels.get(id);
      const adapter = record?.enabled ? adapterFor(record.kind) : undefined;
      if (!record || !adapter?.send) throw new Error(`Channel ${id} is missing, disabled or cannot send`);
      try {
        const sent = await adapter.send(runtimeFor(record), threadId, message);
        if (record.status === "error") setStatus(id, "ok", null);
        return adapter.edit && sent ? sent.ref : null;
      } catch (error) {
        setStatus(id, "error", `Could not reach the owner: ${describeError(error)}`);
        throw error;
      }
    },

    /** Replace a sent notice's text and drop its buttons. False when the channel cannot edit. */
    async edit(id: string, threadId: string, ref: string, text: string): Promise<boolean> {
      const record = store.channels.get(id);
      const adapter = record?.enabled ? adapterFor(record.kind) : undefined;
      if (!record || !adapter?.edit) return false;
      await adapter.edit(runtimeFor(record), threadId, ref, text);
      return true;
    },

    hook,
    /** Newest first; null when the channel doesn't exist. */
    activity: (id: string) => (store.channels.get(id) ? store.channelActivity.list(id) : null),
    setup: setupSteps,
    test: testWebhook,


    stopAll: () => Promise.all([...connections.keys()].map(stopConnection)),
  };
}
