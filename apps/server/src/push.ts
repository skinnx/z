/** Web Push delivery to every registered device. Dead subscriptions (404/410) are dropped. */
import { describeError } from "@z/core";
import type { Runtime } from "./runtime.ts";
import { buildPushRequest, generateVapidKeys, vapidPublicKey, type VapidKeys } from "./webpush.ts";

/**
 * What the service worker receives. Never secrets: an approval's body is its preview, with secret-named
 * arguments masked. `truncated`: the body is not the whole action, so the worker offers no Approve.
 * `question`: at most two short choices the worker offers as answer actions (the body is the whole question).
 */
export type PushPayload = {
  id: string;
  kind: string;
  title: string;
  body: string;
  path: string;
  approvalId?: string;
  truncated?: boolean;
  question?: { taskId: string; choices: string[] };
};

/** One device's answer: accepted, or gone for good (404/410, already removed). Other failures throw. */
export type PushOutcome = "sent" | "gone";

export type Push = ReturnType<typeof createPush>;

export function createPush(rt: Runtime) {
  const { store } = rt;

  /** Generated on first use and sealed like every other secret. */
  function keys(): VapidKeys {
    const existing = store.push.vapid.get();
    if (existing) return existing;
    const created = generateVapidKeys();
    store.push.vapid.set(created);
    return created;
  }

  // Push services want a way to reach the sender: an https origin or a mailto.
  const subject = () =>
    process.env.Z_VAPID_SUBJECT?.trim() || (rt.env.publicUrl?.startsWith("https://") ? rt.env.publicUrl : "mailto:z@localhost");

  const hostOf = (endpoint: string) => new URL(endpoint).host;

  /** Push to one registered device. Throws on a failure worth retrying. */
  async function deliver(endpoint: string, payload: PushPayload): Promise<PushOutcome> {
    const device = store.push.list().find((d) => d.endpoint === endpoint);
    if (!device) return "gone";
    const vapid = { keys: keys(), subject: subject() };
    const { url, init } = buildPushRequest(device, payload, vapid, {
      urgency: payload.approvalId || payload.question ? "high" : "normal",
      ttl: payload.approvalId ? 7 * 24 * 3600 : 24 * 3600,
    });
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
    await res.body?.cancel();
    if (res.status === 404 || res.status === 410) {
      store.push.delete(device.endpoint);
      console.log(`[z:push] removed expired device "${device.device || hostOf(device.endpoint)}"`);
      return "gone";
    }
    if (!res.ok) throw new Error(`${hostOf(device.endpoint)} answered ${res.status}`);
    return "sent";
  }

  return {
    publicKey: () => vapidPublicKey(keys()),
    deliver,
    /** Registered device endpoints: the outbox's push targets. */
    endpoints: () => store.push.list().map((d) => d.endpoint),

    /** One immediate try to every device (the test button). Resolves to the number that accepted it. */
    async send(payload: PushPayload): Promise<number> {
      const results = await Promise.all(
        store.push.list().map((device) =>
          deliver(device.endpoint, payload).then(
            (outcome) => outcome === "sent",
            (error) => {
              console.error(`[z:push] ${hostOf(device.endpoint)}: ${describeError(error)}`);
              return false;
            },
          ),
        ),
      );
      return results.filter(Boolean).length;
    },
  };
}
