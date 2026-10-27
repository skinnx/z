import { linkCode, type ChannelRuntime, type InboundMessage } from "@z/core";
import { backoff, errorMessage, sleep } from "../util.ts";

/** Unaddressed messages only matter when the channel answers everything, or to pair the owner (`/link <code>`). */
export function shouldDispatch(message: InboundMessage, runtime: ChannelRuntime): boolean {
  return message.addressed || runtime.channel.always || linkCode(message.text) !== null;
}

export type Action = { id: string; label: string; style?: "primary" | "danger" };

/**
 * Run a button press through the runtime. `final` means the action was carried out (or is moot):
 * show `ack` in place of the buttons. Otherwise it was refused and the buttons stay for the owner.
 */
export async function pressed(
  runtime: ChannelRuntime,
  actionId: string,
  from: { threadId: string; authorId: string },
): Promise<{ ack: string; final: boolean }> {
  try {
    return { ack: await runtime.act(actionId, from), final: true };
  } catch (error) {
    return { ack: errorMessage(error), final: false };
  }
}

export function config(runtime: ChannelRuntime, key: string): string {
  return runtime.channel.config[key]?.trim() ?? "";
}

/**
 * Validate credentials before a connect-mode adapter reports healthy. The first check is awaited
 * by `start` so a bad token shows as an error immediately (the server marks a channel "Connected"
 * when `start` returns without one); after that it retries with backoff until it passes.
 * Resolves false only when stopped.
 */
export async function untilAuthorized(
  runtime: ChannelRuntime,
  check: () => Promise<unknown>,
  signal: AbortSignal,
): Promise<{ first: boolean; ready: Promise<boolean> }> {
  const attempt = async () => {
    try {
      await check();
      return true;
    } catch (error) {
      if (!signal.aborted) runtime.status("error", errorMessage(error));
      return false;
    }
  };
  const first = await attempt();
  const ready = first
    ? Promise.resolve(true)
    : (async () => {
        for (let n = 1; !signal.aborted; n++) {
          await sleep(backoff(n, 300_000), signal);
          if (!signal.aborted && (await attempt())) {
            runtime.status("ok", "Credentials accepted");
            return true;
          }
        }
        return false;
      })();
  return { first, ready };
}
