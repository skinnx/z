/**
 * The delivery hub. Every Notice is stored, streamed to open apps, and queued in a durable outbox:
 * one delivery per registered device and one to the paired owner channel (with Approve / Deny or
 * answer buttons). Failed attempts retry with backoff and survive restarts (see "Delivery & missed
 * runs" in the contract).
 *
 *   notify({ kind: "watch", title: "Price dropped", body: "…", path: "/tasks?task=…" });
 *
 * Approve only what you can see: an approval's body is its complete preview, and push or channel
 * messages carry an Approve button only when all of it fits the medium. Otherwise they say
 * "Open z to review" and approve nothing.
 */
import { randomUUID } from "node:crypto";
import {
  DELIVERY_BACKOFF_MS,
  describeError,
  MAX_DELIVERY_ATTEMPTS,
  previewFits,
  type Approval,
  type Notice,
  type NoticeQuestion,
} from "@z/core";
import type { Channels } from "./channels.ts";
import type { Push, PushPayload } from "./push.ts";
import type { Runtime } from "./runtime.ts";
import type { DeliveryRecord } from "./store.ts";

export type NoticeInput = Omit<Notice, "id" | "read" | "createdAt">;

/** What the service worker shows; longer bodies are cut, so an approval that needs more opens the app. */
export const PUSH_BODY_MAX = 600;
const OPEN_TO_REVIEW = "Too long to approve here. Open z to review it.";
/** Choices short and few enough to become buttons on the owner channel; push offers at most two. */
const MAX_BUTTONS = 4;
const MAX_PUSH_CHOICES = 2;
const MAX_BUTTON_LABEL = 30;
/** A delivery being attempted is leased this long, so a crash mid-attempt retries it after a restart. */
const LEASE_MS = 60_000;

export const buttonable = (choices: string[], max = MAX_BUTTONS) =>
  choices.length > 0 && choices.length <= max && choices.every((c) => c.length <= MAX_BUTTON_LABEL);

/** The transports the outbox drives; tests pass fakes for the network edge only. */
export type Transports = {
  push: Pick<Push, "deliver" | "endpoints">;
  channels: Pick<Channels, "send" | "edit" | "noticeLimit">;
};
/** `now`: the clock (ms) for due times. `timers: false` leaves retries to explicit `runDue()` calls (tests). */
export type OutboxOptions = { now?: () => number; timers?: boolean };
export type Outbox = ReturnType<typeof createOutbox>;

let hub: { rt: Runtime; outbox: Outbox; now: () => number } | null = null;

/** Wire the hub once at startup, before anything can raise a notice; resumes waiting deliveries. */
export function startDelivery(rt: Runtime, push: Transports["push"], channels: Transports["channels"], options: OutboxOptions = {}): Outbox {
  hub?.outbox.stop();
  const outbox = createOutbox(rt, { push, channels }, options);
  hub = { rt, outbox, now: options.now ?? Date.now };
  outbox.start();
  return outbox;
}

/** Persist a notice, stream it to open apps and queue its deliveries. Never throws on delivery. */
export function notify(input: NoticeInput): Notice {
  if (!hub) throw new Error("notify() called before startDelivery()");
  const notice: Notice = { id: randomUUID(), ...input, read: false, createdAt: new Date(hub.now()).toISOString() };
  hub.rt.store.notices.insert(notice);
  hub.rt.bus.emit({ type: "notice", notice });
  hub.outbox.enqueue(notice);
  return notice;
}

/** An approval was decided or expired: drop its waiting deliveries and edit sent channel messages. */
export function settleApproval(approval: Pick<Approval, "id" | "status">) {
  if (!hub) return;
  const outcome = approval.status === "approved" ? "Approved." : approval.status === "denied" ? "Denied." : "Expired: no longer needed.";
  hub.outbox.settle(hub.rt.store.notices.forApproval(approval.id), outcome);
}

/**
 * A task's question was answered (anywhere) or withdrawn (`answer` null): its notices lose their
 * buttons in the app, waiting deliveries are dropped and sent channel messages show the answer.
 */
export function settleQuestion(taskId: string, answer: string | null) {
  if (!hub) return;
  const { store, bus } = hub.rt;
  const settled: Notice[] = [];
  for (const notice of store.notices.openQuestions(taskId)) {
    const question: NoticeQuestion = { ...notice.question!, answer: answer ?? "" };
    store.notices.setQuestion(notice.id, question);
    const updated = { ...notice, question };
    bus.emit({ type: "notice", notice: updated });
    settled.push(updated);
  }
  hub.outbox.settle(settled, answer === null ? "No longer needed." : `Answered: ${answer}`);
}

/** An approval notice's body: why it asks, then the whole preview. */
export function approvalBody(approval: Pick<Approval, "reason" | "preview">): string {
  return [approval.reason ? `Asking because ${approval.reason}` : "", approval.preview.fullText].filter(Boolean).join("\n\n");
}

/**
 * The push payload: Approve / Deny only when the complete body fits; otherwise marked truncated.
 * A question with one or two short choices carries them, when the whole question fits.
 */
export function pushPayload({ id, kind, title, body, path, approvalId, question }: Notice): PushPayload {
  if (question && !question.answer && buttonable(question.choices, MAX_PUSH_CHOICES) && previewFits(body, PUSH_BODY_MAX)) {
    return { id, kind, title, body, path, question: { taskId: question.taskId, choices: question.choices } };
  }
  if (!approvalId) return { id, kind, title, body: clip(body, PUSH_BODY_MAX), path };
  if (previewFits(body, PUSH_BODY_MAX)) return { id, kind, title, body, path, approvalId };
  return { id, kind, title, body: `${clip(body, PUSH_BODY_MAX - OPEN_TO_REVIEW.length - 2)}\n\n${OPEN_TO_REVIEW}`, path, approvalId, truncated: true };
}

/** The owner-channel message: buttons only when title, complete body and link fit `limit`. */
export function channelMessage({ title, body, approvalId, question }: Notice, link: string, limit: number): Parameters<Channels["send"]>[2] {
  const text = `${title}\n${body}${link}`;
  if (question && !question.answer && buttonable(question.choices) && previewFits(text, limit)) {
    return { text, actions: question.choices.map((label, i) => ({ id: `answer:${question.taskId}:${i}`, label })) };
  }
  if (!approvalId) return { text };
  if (previewFits(text, limit)) {
    return {
      text,
      actions: [
        { id: `approve:${approvalId}`, label: "Approve", style: "primary" },
        { id: `deny:${approvalId}`, label: "Deny", style: "danger" },
      ],
    };
  }
  const room = Math.max(80, limit - title.length - link.length - OPEN_TO_REVIEW.length - 8);
  return { text: `${title}\n${clip(body, room)}\n\n${OPEN_TO_REVIEW}${link}` };
}

/** The durable outbox: one delivery per (notice, target), attempted now and retried with backoff. */
export function createOutbox(rt: Pick<Runtime, "store" | "env">, { push, channels }: Transports, { now = Date.now, timers = true }: OutboxOptions = {}) {
  const { store } = rt;
  const iso = (ms: number) => new Date(ms).toISOString();
  const flights = new Set<Promise<void>>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const linkFor = (notice: Notice) => (rt.env.publicUrl ? `\n${rt.env.publicUrl}${notice.path}` : "");
  const label = (d: DeliveryRecord, notice: Notice | null) =>
    `${notice?.kind ?? "?"} notice ${d.noticeId.slice(0, 8)} → ${d.target === "push" ? `push ${hostOf(d.address)}` : `channel ${d.address}`}`;

  /** Why a delivery is no longer worth sending, or null. */
  function moot(notice: Notice, d: DeliveryRecord): string | null {
    if (notice.approvalId && store.approvals.get(notice.approvalId)?.status !== "pending") return "approval already decided";
    if (notice.question) {
      const task = store.tasks.get(notice.question.taskId);
      if (notice.question.answer !== undefined || task?.status !== "needs_input") return "question already answered";
    }
    if (d.target === "channel") {
      const owner = store.settings.get().owner;
      if (!owner || owner.channelId !== d.address || owner.threadId !== d.threadId) return "owner channel changed";
    }
    return null;
  }

  async function attempt(d: DeliveryRecord) {
    const notice = store.notices.get(d.noticeId);
    const reason = notice ? moot(notice, d) : "notice deleted";
    if (!notice || reason) return store.outbox.update(d.id, { status: "dropped", nextAttemptAt: null, lastError: reason }, iso(now()));
    const attempts = d.attempts + 1;
    try {
      let ref: string | null = null;
      if (d.target === "push") {
        if ((await push.deliver(d.address, pushPayload(notice))) === "gone") {
          return store.outbox.update(d.id, { status: "dropped", attempts, nextAttemptAt: null, lastError: "device unsubscribed" }, iso(now()));
        }
      } else {
        const message = channelMessage(notice, linkFor(notice), channels.noticeLimit(d.address));
        ref = await channels.send(d.address, d.threadId ?? "", { ...message, id: d.id });
      }
      store.outbox.update(d.id, { status: "sent", attempts, nextAttemptAt: null, lastError: null, ref }, iso(now()));
      if (attempts > 1) console.log(`[z:outbox] ${label(d, notice)}: delivered on attempt ${attempts}`);
      // Decided or answered while this was in flight: take the buttons off again.
      const after = store.notices.get(d.noticeId);
      if (ref && after && (after.question?.answer !== undefined || (after.approvalId && store.approvals.get(after.approvalId)?.status !== "pending"))) {
        await edit({ ...d, ref }, after, after.question?.answer !== undefined ? `Answered: ${after.question.answer}` : "Already decided.");
      }
    } catch (error) {
      const lastError = describeError(error);
      if (attempts >= MAX_DELIVERY_ATTEMPTS) {
        store.outbox.update(d.id, { status: "failed", attempts, nextAttemptAt: null, lastError }, iso(now()));
        console.error(`[z:outbox] ${label(d, notice)}: gave up after ${attempts} attempts: ${lastError}`);
        return;
      }
      const next = iso(now() + DELIVERY_BACKOFF_MS[attempts - 1]!);
      store.outbox.update(d.id, { status: "pending", attempts, nextAttemptAt: next, lastError }, iso(now()));
      console.error(`[z:outbox] ${label(d, notice)}: attempt ${attempts} failed (${lastError}); retrying at ${next}`);
    }
  }

  async function edit(d: DeliveryRecord, notice: Notice, outcome: string) {
    if (d.target !== "channel" || !d.ref) return;
    const link = linkFor(notice);
    const room = Math.max(80, Math.min(channels.noticeLimit(d.address), 4000) - link.length - outcome.length - 4);
    try {
      await channels.edit(d.address, d.threadId ?? "", d.ref, `${clip(`${notice.title}\n${notice.body}`, room)}${link}\n\n${outcome}`);
    } catch (error) {
      console.error(`[z:outbox] ${label(d, notice)}: could not edit the sent message: ${describeError(error)}`);
    }
  }

  /** Attempt every due delivery once (each is leased first, so overlapping calls never double-send). */
  function runDue(): Promise<void> {
    const at = now();
    const due = store.outbox.due(iso(at));
    for (const d of due) store.outbox.update(d.id, { nextAttemptAt: iso(at + LEASE_MS) }, iso(at));
    const flight = Promise.all(due.map((d) => attempt(d).catch((error) => console.error(`[z:outbox] ${describeError(error)}`)))).then(() => {
      flights.delete(flight);
      arm();
    });
    flights.add(flight);
    return flight;
  }

  /** One timer for the earliest waiting delivery. */
  function arm() {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!timers || stopped) return;
    const next = store.outbox.nextDueAt();
    if (!next) return;
    const delay = Math.min(Math.max(0, Date.parse(next) - now()), 2 ** 31 - 1);
    timer = setTimeout(() => void runDue(), delay);
    timer.unref?.();
  }

  return {
    /** Queue a notice for every target known now: each push device and the paired owner channel. */
    enqueue(notice: Notice) {
      const at = iso(now());
      const rows: Parameters<typeof store.outbox.insert>[0] = push
        .endpoints()
        .map((endpoint) => ({ id: randomUUID(), noticeId: notice.id, target: "push", address: endpoint, threadId: null, nextAttemptAt: at }));
      const owner = store.settings.get().owner;
      if (owner) rows.push({ id: randomUUID(), noticeId: notice.id, target: "channel", address: owner.channelId, threadId: owner.threadId, nextAttemptAt: at });
      if (!rows.length) return;
      store.outbox.insert(rows, at);
      if (!stopped) void runDue();
    },

    /** The notices' question or approval is settled: drop waiting deliveries, edit sent channel messages. */
    settle(notices: Notice[], outcome: string) {
      const at = iso(now());
      for (const notice of notices) {
        for (const d of store.outbox.forNotice(notice.id)) {
          if (d.status === "pending") store.outbox.update(d.id, { status: "dropped", nextAttemptAt: null, lastError: "settled before delivery" }, at);
          else if (d.status === "sent" && d.ref) void edit(d, notice, outcome);
        }
      }
    },

    runDue,
    /** Resolves once every attempt in flight has finished. */
    drain: async () => {
      while (flights.size) await Promise.all([...flights]);
    },
    /** Startup: send what is due (including deliveries a crash left leased) and arm the timer. */
    start() {
      stopped = false;
      void runDue();
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

const hostOf = (endpoint: string) => {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint.slice(0, 40);
  }
};

export const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
