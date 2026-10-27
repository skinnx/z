/** Web Push delivery to every registered device. Dead subscriptions (404/410) are dropped. */
import { describeError } from "@z/core";
import type { Runtime } from "./runtime.ts";
import { buildPushRequest, generateVapidKeys, vapidPublicKey, type VapidKeys } from "./webpush.ts";

/** What the service worker receives. Never secrets or tool inputs: just enough to show and act. */
export type PushPayload = { id: string; kind: string; title: string; body: string; path: string; approvalId?: string };

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

  return {
    publicKey: () => vapidPublicKey(keys()),

    /** Resolves to the number of devices the push service accepted the message for. */
    async send(payload: PushPayload): Promise<number> {
      const devices = store.push.list();
      if (!devices.length) return 0;
      const vapid = { keys: keys(), subject: subject() };
      const results = await Promise.all(
        devices.map(async (device) => {
          try {
            const { url, init } = buildPushRequest(device, payload, vapid, {
              urgency: payload.approvalId ? "high" : "normal",
              ttl: payload.approvalId ? 7 * 24 * 3600 : 24 * 3600,
            });
            const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
            await res.body?.cancel();
            if (res.status === 404 || res.status === 410) {
              store.push.delete(device.endpoint);
              console.log(`[z:push] removed expired device "${device.device || new URL(device.endpoint).host}"`);
              return false;
            }
            if (!res.ok) console.error(`[z:push] ${new URL(device.endpoint).host} answered ${res.status}`);
            return res.ok;
          } catch (error) {
            console.error(`[z:push] ${new URL(device.endpoint).host}: ${describeError(error)}`);
            return false;
          }
        }),
      );
      return results.filter(Boolean).length;
    },
  };
}
