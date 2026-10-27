import type { ChannelAdapter, ChannelRuntime, InboundMessage, OutboundReply } from "@z/core";
import { backoff, errorMessage, sleep } from "../util.ts";
import { config, untilAuthorized } from "./shared.ts";

const API = "https://api.x.com/2";

export type Tweet = {
  id: string;
  text: string;
  author_id?: string;
  conversation_id?: string;
  created_at?: string;
  referenced_tweets?: { type: "replied_to" | "quoted" | "retweeted"; id: string }[];
  note_tweet?: { text: string };
  attachments?: { media_keys?: string[] };
};
export type XUser = { id: string; username: string; name: string };
export type XMedia = { media_key: string; type: "photo" | "video" | "animated_gif"; url?: string; preview_image_url?: string };
export type Includes = { tweets?: Tweet[]; users?: XUser[]; media?: XMedia[] };

/** Photo URLs, or the preview frame of videos and GIFs. */
function tweetImages(tweet: Tweet, media: Map<string, XMedia>): string[] {
  return (tweet.attachments?.media_keys ?? []).flatMap((key) => {
    const m = media.get(key);
    const url = m?.type === "photo" ? m.url : m?.preview_image_url;
    return url ? [url] : [];
  });
}

/** Pure mapping from a mentions-timeline tweet; null when it should be ignored. */
export function xToInbound(
  tweet: Tweet,
  includes: Includes,
  opts: { channelId: string; botUserId: string; botUsername: string; handle: string },
): InboundMessage | null {
  if (tweet.author_id === opts.botUserId) return null;
  if (tweet.referenced_tweets?.some((r) => r.type === "retweeted")) return null;
  const users = new Map((includes.users ?? []).map((u) => [u.id, u]));
  const tweets = new Map((includes.tweets ?? []).map((t) => [t.id, t]));
  const media = new Map((includes.media ?? []).map((m) => [m.media_key, m]));
  const author = tweet.author_id ? users.get(tweet.author_id) : undefined;
  const full = tweet.note_tweet?.text ?? tweet.text;
  // Replies start with an auto-inserted run of @handles; drop it so the question stands alone.
  const stripped = full.replace(/^(\s*@\w+)+\s*/, "").trim();
  const text = (stripped || full).replace(new RegExp(`@${opts.botUsername}\\b`, "gi"), `@${opts.handle}`);
  // The replied-to or quoted post is what "is this true?" refers to.
  const context = (tweet.referenced_tweets ?? []).flatMap((ref) => {
    const t = tweets.get(ref.id);
    if (!t) return [];
    const who = t.author_id ? users.get(t.author_id) : undefined;
    const handle = who ? `@${who.username}` : "unknown";
    const url = who ? `https://x.com/${who.username}/status/${t.id}` : `https://x.com/i/status/${t.id}`;
    const images = tweetImages(t, media);
    return [
      {
        author: ref.type === "quoted" ? `${handle} (quoted)` : handle,
        text: t.note_tweet?.text ?? t.text,
        url,
        ...(images.length ? { images } : {}),
      },
    ];
  });
  const images = tweetImages(tweet, media);
  return {
    channelId: opts.channelId,
    threadId: tweet.conversation_id ?? tweet.id,
    messageId: tweet.id,
    author: { id: tweet.author_id ?? "unknown", name: author ? `@${author.username}` : "unknown" },
    text,
    addressed: true,
    ...(context.length ? { context } : {}),
    ...(images.length ? { images } : {}),
    receivedAt: tweet.created_at ?? new Date().toISOString(),
  };
}

/** X weighs most CJK/emoji as 2; counting every char outside the Latin-ish ranges as 2 is conservative. */
function weight(cp: number): number {
  return cp <= 0x10ff || (cp >= 0x2000 && cp <= 0x200d) || (cp >= 0x2010 && cp <= 0x201f) || (cp >= 0x2032 && cp <= 0x2037)
    ? 1
    : 2;
}

/** X counts every link as 23 characters (t.co), whatever its length. */
const TCO_LENGTH = 23;

/** The reply as one post: the text, then the best (first) source link when there is one. */
export function tweetText(reply: OutboundReply): string {
  const link = reply.sources?.[0]?.url;
  return link ? `${fitTweet(reply.text, 280 - TCO_LENGTH - 1)}\n${link}` : fitTweet(reply.text);
}

/** Truncate to X's 280 weighted characters, preferring a word boundary. */
export function fitTweet(text: string, max = 280): string {
  const chars = [...text.trim()];
  let total = 0;
  for (const c of chars) total += weight(c.codePointAt(0)!);
  if (total <= max) return text.trim();
  let used = 1; // the ellipsis
  let end = 0;
  while (end < chars.length && used + weight(chars[end]!.codePointAt(0)!) <= max) used += weight(chars[end++]!.codePointAt(0)!);
  let cut = chars.slice(0, end).join("");
  const space = cut.search(/\s\S*$/);
  if (space > cut.length * 0.7) cut = cut.slice(0, space);
  return cut.trimEnd() + "…";
}

class XError extends Error {
  status: number;
  waitMs: number;
  constructor(message: string, status: number, waitMs: number) {
    super(message);
    this.status = status;
    this.waitMs = waitMs;
  }
}

/** Milliseconds until the rate-limit window resets when it is exhausted, else 0. */
function rateLimitWait(res: Response): number {
  const remaining = res.headers.get("x-rate-limit-remaining");
  const reset = Number(res.headers.get("x-rate-limit-reset"));
  if (res.status !== 429 && remaining !== "0") return 0;
  return reset ? Math.max(1000, reset * 1000 - Date.now() + 1000) : 15 * 60_000;
}

async function xApi<T>(runtime: ChannelRuntime, path: string, init: RequestInit = {}, signal?: AbortSignal) {
  const res = await runtime.fetch(`${API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${config(runtime, "bearerToken")}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
    ...(signal ? { signal } : {}),
  });
  const wait = rateLimitWait(res);
  const data = (await res.json().catch(() => ({}))) as T & { title?: string; detail?: string };
  if (!res.ok) {
    let detail = data.detail ?? data.title ?? res.statusText;
    if (res.status === 401) detail += " (OAuth2 user tokens expire after 2 hours; issue a fresh one)";
    throw new XError(`X ${init.method ?? "GET"} ${path.split("?")[0]}: ${res.status} ${detail}`, res.status, wait);
  }
  return { data, wait };
}

type MentionsPage = { data?: Tweet[]; includes?: Includes; meta?: { newest_id?: string; next_token?: string } };

async function whoAmI(runtime: ChannelRuntime, signal: AbortSignal): Promise<XUser> {
  const { data } = await xApi<{ data: XUser }>(runtime, "/users/me", {}, signal);
  const userId = config(runtime, "userId");
  return userId && userId !== data.data.id ? { ...data.data, id: userId } : data.data;
}

async function poll(runtime: ChannelRuntime, me: XUser, signal: AbortSignal): Promise<void> {
  const pollMs = Math.max(15, Number(config(runtime, "pollSeconds")) || 60) * 1000;
  // Cursor keys are per bot account, so swapping the token does not reuse another account's cursor.
  const key = (name: string) => `${name}:${me.id}`;
  let sinceId = runtime.state.get(key("sinceId"));
  let baselined = runtime.state.get(key("baselined")) === "1";
  let healthy = true;
  let attempt = 0;
  while (!signal.aborted) {
    let waitMs = pollMs;
    try {
      const tweets: Tweet[] = [];
      const includes: Required<Includes> = { tweets: [], users: [], media: [] };
      let newest: string | undefined;
      let page: string | undefined;
      // On the first poll only record where the timeline is, so old mentions are not answered.
      for (let i = 0; i < (baselined ? 5 : 1); i++) {
        const q = new URLSearchParams({
          max_results: baselined ? "100" : "5",
          expansions:
            "referenced_tweets.id,author_id,referenced_tweets.id.author_id,attachments.media_keys,referenced_tweets.id.attachments.media_keys",
          "tweet.fields": "created_at,conversation_id,referenced_tweets,author_id,note_tweet",
          "user.fields": "username,name",
          "media.fields": "url,preview_image_url,type",
        });
        if (sinceId) q.set("since_id", sinceId);
        if (page) q.set("pagination_token", page);
        const { data, wait } = await xApi<MentionsPage>(runtime, `/users/${me.id}/mentions?${q}`, {}, signal);
        waitMs = Math.max(waitMs, wait);
        newest ??= data.meta?.newest_id;
        tweets.push(...(data.data ?? []));
        includes.tweets.push(...(data.includes?.tweets ?? []));
        includes.users.push(...(data.includes?.users ?? []));
        includes.media.push(...(data.includes?.media ?? []));
        page = data.meta?.next_token;
        if (!page || wait) break;
      }
      if (!baselined) {
        // First run ever: only record where the timeline is, so old mentions are not answered.
        baselined = true;
        runtime.state.set(key("baselined"), "1");
      } else {
        // The timeline is newest first; answer in the order people asked, advancing the cursor
        // after each so a restart mid-batch resumes after the last answered mention.
        for (const tweet of tweets.reverse()) {
          if (signal.aborted) return;
          await answer(runtime, tweet, includes, me);
          sinceId = tweet.id;
          runtime.state.set(key("sinceId"), sinceId);
        }
      }
      if (newest && newest !== sinceId) {
        sinceId = newest;
        runtime.state.set(key("sinceId"), sinceId);
      }
      attempt = 0;
      if (!healthy) runtime.status("ok", `Watching mentions of @${me.username}`);
      healthy = true;
    } catch (error) {
      if (signal.aborted) return;
      healthy = false;
      runtime.status("error", errorMessage(error));
      const rate = error instanceof XError ? error.waitMs : 0;
      const auth = error instanceof XError && (error.status === 401 || error.status === 403);
      waitMs = Math.max(rate, auth ? 5 * 60_000 : backoff(attempt++, 5 * 60_000));
    }
    await sleep(waitMs, signal);
  }
}

async function answer(runtime: ChannelRuntime, tweet: Tweet, includes: Includes, me: XUser): Promise<void> {
  const message = xToInbound(tweet, includes, {
    channelId: runtime.channel.id,
    botUserId: me.id,
    botUsername: me.username,
    handle: runtime.handle,
  });
  if (!message) return;
  try {
    const reply = await runtime.dispatch(message);
    if (!reply) return;
    await xApi(runtime, "/tweets", {
      method: "POST",
      body: JSON.stringify({ text: tweetText(reply), reply: { in_reply_to_tweet_id: reply.replyTo || tweet.id } }),
    });
  } catch (error) {
    runtime.log(`x: reply to ${tweet.id} failed: ${errorMessage(error)}`);
  }
}

export const xAdapter: ChannelAdapter = {
  kind: "x",
  label: "X (Twitter)",
  config: [
    {
      key: "bearerToken",
      label: "OAuth2 user access token (tweet.read, tweet.write, users.read)",
      secret: true,
      required: true,
    },
    { key: "userId", label: "Bot user id (optional, resolved from the token)" },
    { key: "pollSeconds", label: "Poll interval in seconds (default 60)" },
  ],
  start: async (runtime) => {
    if (!config(runtime, "bearerToken")) {
      runtime.status("error", "bearerToken is required");
      return () => {};
    }
    const controller = new AbortController();
    const { signal } = controller;
    let me: XUser | undefined;
    const auth = await untilAuthorized(runtime, async () => (me = await whoAmI(runtime, signal)), signal);
    if (auth.first) runtime.status("ok", `Watching mentions of @${me!.username}`);
    void auth.ready.then((ok) => {
      if (ok) return poll(runtime, me!, signal);
    });
    return () => controller.abort();
  },
};
