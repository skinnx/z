/** Channel lifecycle: connect-mode adapters, inbound webhooks and bot dispatch. */
import {
  answerMessage,
  describeError,
  linkCode,
  previewFits,
  type ChannelAdapter,
  type ChannelRuntime,
  type ChannelView,
  type InboundMessage,
  type OutboundReply,
} from "@z/core";
import { approvalBody } from "./notify.ts";
import type { Pairing } from "./owner.ts";
import type { Runtime } from "./runtime.ts";
import type { ChannelRecord } from "./store.ts";
import { ConflictError, type Tasks } from "./tasks.ts";

type Connection = { stop: () => void | Promise<void> };

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

  async function dispatch(channelId: string, message: InboundMessage): Promise<OutboundReply | null> {
    store.channels.touch(channelId);
    emit(channelId);
    const record = store.channels.get(channelId);
    if (!record?.enabled) return null;
    // Handled before the model, addressed or not: pairing must not depend on an LLM.
    const code = linkCode(message.text);
    if (code !== null) return { text: link(record, message, code), replyTo: message.messageId };
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

    /** Longest notice with buttons the channel delivers whole (Infinity when its adapter has no limit). */
    noticeLimit(id: string): number {
      const record = store.channels.get(id);
      return (record && adapterFor(record.kind)?.noticeLimit) || Number.POSITIVE_INFINITY;
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
