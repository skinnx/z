import { linkCode, type ChannelRuntime, type InboundMessage, type OutboundReply, type Source } from "@z/core";
import { backoff, errorMessage, sleep, truncate } from "../util.ts";

/**
 * Reply text followed by a "Sources:" line in the platform's link style, within `max` characters.
 * Sources that don't fit are dropped before the text is cut. `escape` applies to the text only
 * (after truncation, so an entity is never cut in half).
 */
export function withSources(
  reply: OutboundReply,
  max: number,
  link: (source: Source) => string,
  escape: (text: string) => string = (t) => t,
): string {
  let line = "";
  for (const source of reply.sources ?? []) {
    const next = line ? `${line} · ${link(source)}` : `Sources: ${link(source)}`;
    if (next.length > max / 2) break;
    line = next;
  }
  if (!line) return escape(truncate(reply.text, max));
  return `${escape(truncate(reply.text, max - line.length - 2))}\n\n${line}`;
}

const MAX_IMAGE_BYTES = 5_000_000;

/**
 * Download an image the model can't fetch itself (auth headers, or a token in the URL) and
 * return it as a `data:` URL; null when it isn't an image or is too large.
 */
export async function imageDataUrl(runtime: ChannelRuntime, url: string, headers: Record<string, string> = {}): Promise<string | null> {
  try {
    const res = await runtime.fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
    const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim();
    const size = Number(res.headers.get("content-length") ?? 0);
    if (!res.ok || !/^image\/(png|jpeg|gif|webp)$/.test(type) || size > MAX_IMAGE_BYTES) {
      await res.body?.cancel();
      return null;
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    return bytes.byteLength > MAX_IMAGE_BYTES ? null : `data:${type};base64,${bytes.toString("base64")}`;
  } catch (error) {
    runtime.log(`could not download an image: ${errorMessage(error)}`);
    return null;
  }
}

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
