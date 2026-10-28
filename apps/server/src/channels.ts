/** Channel lifecycle: connect-mode adapters, inbound webhooks and bot dispatch. */
import {
  answerMessage,
  describeError,
  linkCode,
  type ChannelAdapter,
  type ChannelLimits,
  type ChannelRuntime,
  type ChannelView,
  type InboundMessage,
  type OutboundReply,
} from "@z/core";
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

  function view(record: ChannelRecord): ChannelView {
    const { config: _secret, ...rest } = record;
    return { ...rest, webhookUrl: webhookUrl(record) };
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

  async function dispatch(channelId: string, message: InboundMessage): Promise<OutboundReply | null> {
    store.channels.touch(channelId);
    emit(channelId);
    const record = store.channels.get(channelId);
    if (!record?.enabled) return null;
    // Handled before the model, addressed or not: pairing must not depend on an LLM.
    const code = linkCode(message.text);
    if (code !== null) return { text: link(record, message, code), replyTo: message.messageId };
    const owner = store.settings.get().owner;
    const exempt = owner?.channelId === channelId && owner.authorId === message.author.id;
    // Messages the bot won't answer cost nothing, and the owner is never capped.
    if (exempt || !(message.addressed || record.always)) return answer(record, message);

    let gate = gates.get(channelId);
    if (!gate) gates.set(channelId, (gate = { running: 0, queue: [], averageMs: 30_000 }));
    const author = authorFor(channelId, message.author.id);
    const wait = overLimit(gate, author, record.limits);
    if (wait !== null) {
      // One reply per stretch over the cap, then quiet until the author is under it again.
      if (author.busyNotified) return null;
      author.busyNotified = true;
      return { text: `I'm busy right now. Try again in ${wait} min.`, replyTo: message.messageId };
    }
    author.busyNotified = false;
    author.hits.push(Date.now());
    author.pending++;
    try {
      if (gate.running < record.limits.running) gate.running++;
      else await new Promise<void>((resolve) => gate.queue.push(resolve));
      const started = Date.now();
      try {
        return await answer(record, message);
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

  /** A button press from a channel. Only the paired owner, on the paired channel, may decide. */
  async function act(record: ChannelRecord, actionId: string, from: { threadId: string; authorId: string }): Promise<string> {
    const owner = store.settings.get().owner;
    if (!owner || owner.channelId !== record.id || owner.authorId !== from.authorId) {
      throw new Error("Only z's paired owner can do that.");
    }
    const match = /^(approve|deny):(.+)$/.exec(actionId);
    if (!match) throw new Error("Unknown action.");
    try {
      const approval = tasks.decide(match[2]!, { approve: match[1] === "approve", remember: false });
      if (!approval) return "That approval no longer exists.";
      return `${approval.status === "approved" ? "Approved" : "Denied"}: ${approval.summary}`;
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
      log: (text) => console.log(`[z:channel:${record.id}] ${text}`),
      fetch,
    };
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

    async remove(id: string): Promise<boolean> {
      await (locks.get(id) ?? Promise.resolve());
      await stopConnection(id);
      const settings = store.settings.get();
      if (settings.owner?.channelId === id) store.settings.set({ ...settings, owner: null });
      return store.channels.delete(id);
    },

    /** Unprompted message to a thread (owner notices). Throws when the channel cannot send. */
    async send(id: string, threadId: string, message: OutboundNotice): Promise<void> {
      const record = store.channels.get(id);
      const adapter = record?.enabled ? adapterFor(record.kind) : undefined;
      if (!record || !adapter?.send) throw new Error(`Channel ${id} is missing, disabled or cannot send`);
      try {
        await adapter.send(runtimeFor(record), threadId, message);
      } catch (error) {
        setStatus(id, "error", `Could not reach the owner: ${describeError(error)}`);
        throw error;
      }
    },

    /** `ALL /hooks/:channelId` (some platforms verify with GET). */
    async hook(id: string, request: Request): Promise<Response> {
      const record = store.channels.get(id);
      const adapter = record?.enabled ? adapterFor(record.kind) : undefined;
      if (!record || !adapter?.webhook) return Response.json({ error: "Unknown channel" }, { status: 404 });
      try {
        return await adapter.webhook(request, runtimeFor(record));
      } catch (error) {
        setStatus(id, "error", `Webhook failed: ${describeError(error)}`);
        return Response.json({ error: "Webhook handler failed" }, { status: 500 });
      }
    },

    stopAll: () => Promise.all([...connections.keys()].map(stopConnection)),
  };
}
