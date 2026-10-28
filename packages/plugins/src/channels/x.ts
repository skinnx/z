import { createHash } from "node:crypto";
import type { ChannelAdapter, ChannelRuntime, InboundMessage, OutboundReply } from "@z/core";
import { backoff, errorMessage, sleep } from "../util.ts";
import { config, requestSignal, step, untilAuthorized } from "./shared.ts";

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

// ─── OAuth2 user tokens: X's expire after 2 hours; with a refresh token z renews them ──────

const TOKEN_URL = `${API}/oauth2/token`;
/** Renew this long before the access token expires (polls run every minute or so). */
const REFRESH_AHEAD_MS = 5 * 60_000;
const REFRESH_TIMEOUT_MS = 15_000;

/**
 * The bearer token to send, renewed with the refresh token when there is one. X rotates refresh
 * tokens on every use, so the current pair lives in `runtime.state` (keyed by a hash of the
 * configured refresh token: pasting a new one in the settings starts over from it). Token values
 * never reach logs or status text.
 */
type XAuth = { refreshable: boolean; token: (signal?: AbortSignal) => Promise<string>; refresh: (signal?: AbortSignal) => Promise<void> };

const auths = new WeakMap<ChannelRuntime, XAuth>();

export function xAuth(runtime: ChannelRuntime): XAuth {
  const cached = auths.get(runtime);
  if (cached) return cached;
  const seedToken = config(runtime, "refreshToken");
  const clientId = config(runtime, "clientId");
  const clientSecret = config(runtime, "clientSecret");
  const refreshable = Boolean(seedToken && clientId);
  const key = (name: string) => `oauth:${name}`;
  if (refreshable) {
    const seed = createHash("sha256").update(`${clientId}\n${seedToken}`).digest("base64url");
    if (runtime.state.get(key("seed")) !== seed) {
      runtime.state.set(key("seed"), seed);
      for (const name of ["access", "refresh", "expiresAt"]) runtime.state.set(key(name), "");
    }
  }
  let inFlight: Promise<void> | null = null;

  async function exchange(signal?: AbortSignal): Promise<void> {
    const refreshToken = runtime.state.get(key("refresh")) || seedToken;
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
    const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId });
    // Confidential apps authenticate with Basic; public (PKCE) apps send only client_id.
    if (clientSecret) headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString("base64")}`;
    const timeout = AbortSignal.timeout(REFRESH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await runtime.fetch(TOKEN_URL, { method: "POST", headers, body, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new XError(`X token refresh: could not reach X (${errorMessage(error)}); retrying`, 503, 0);
    }
    const data = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string };
    if (res.ok && data.access_token) {
      runtime.state.set(key("access"), data.access_token);
      if (data.refresh_token) runtime.state.set(key("refresh"), data.refresh_token);
      runtime.state.set(key("expiresAt"), data.expires_in ? String(Date.now() + data.expires_in * 1000) : "");
      runtime.log("x: access token renewed");
      return;
    }
    if (res.status === 429 || res.status >= 500 || res.ok) {
      throw new XError(`X token refresh: HTTP ${res.status}; retrying`, res.status === 429 ? 429 : 503, rateLimitWait(res));
    }
    // invalid_grant (used, revoked or expired refresh token), invalid_client, …: only a new token helps.
    const why = [data.error, data.error_description].filter(Boolean).join(": ") || `HTTP ${res.status}`;
    throw new XError(`X rejected the refresh token (${why}). Authorize the app again and paste the new refresh token in the channel settings.`, 401, 0);
  }

  const auth: XAuth = {
    refreshable,
    refresh: (signal) => (inFlight ??= exchange(signal).finally(() => (inFlight = null))),
    async token(signal) {
      if (!refreshable) return config(runtime, "bearerToken");
      const expiresAt = Number(runtime.state.get(key("expiresAt")) || 0);
      const access = runtime.state.get(key("access")) || "";
      // A pasted access token of unknown age is used until X answers 401.
      if (!access && !config(runtime, "bearerToken")) await auth.refresh(signal);
      else if (access && expiresAt && expiresAt - Date.now() < REFRESH_AHEAD_MS) await auth.refresh(signal);
      return runtime.state.get(key("access")) || config(runtime, "bearerToken");
    },
  };
  auths.set(runtime, auth);
  return auth;
}

export async function xApi<T>(runtime: ChannelRuntime, path: string, init: RequestInit = {}, signal?: AbortSignal, retried = false): Promise<{ data: T; wait: number }> {
  const auth = xAuth(runtime);
  const res = await runtime.fetch(`${API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${await auth.token(signal)}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
    signal: requestSignal(signal),
  });
  // A 401 means the request did nothing, so after a renewal it is safe to send once more.
  if (res.status === 401 && auth.refreshable && !retried) {
    await res.body?.cancel();
    await auth.refresh(signal);
    return xApi<T>(runtime, path, init, signal, true);
  }
  const wait = rateLimitWait(res);
  const data = (await res.json().catch(() => ({}))) as T & { title?: string; detail?: string };
  if (!res.ok) {
    let detail = data.detail ?? data.title ?? res.statusText;
    if (res.status === 401 && !auth.refreshable) {
      detail += " (OAuth2 user tokens expire after 2 hours: issue a fresh one, or add a refresh token and client id to renew it automatically)";
    }
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
      label: "OAuth2 user access token (tweet.read, tweet.write, users.read); optional with a refresh token",
      secret: true,
    },
    { key: "refreshToken", label: "OAuth2 refresh token (scope offline.access): renews the 2-hour access token", secret: true },
    { key: "clientId", label: "OAuth2 client id of your X app (needed with a refresh token)" },
    { key: "clientSecret", label: "OAuth2 client secret (confidential apps only)", secret: true },
    { key: "userId", label: "Bot user id (optional, resolved from the token)" },
    { key: "pollSeconds", label: "Poll interval in seconds (default 60)" },
  ],
  // From config and what the running poller saw: X's API is metered, and a refresh from here could race the poller's.
  setup: async (runtime) => {
    const portal = "https://developer.x.com/en/portal/dashboard";
    const refreshToken = config(runtime, "refreshToken");
    const clientId = config(runtime, "clientId");
    const username = runtime.state.get("username");
    const hasToken = Boolean(config(runtime, "bearerToken") || (refreshToken && clientId));
    return [
      step("x.token", "Access token", !hasToken ? "error" : username ? "done" : "todo", {
        ...(username ? { detail: `@${username}` } : {}),
        link: portal,
      }),
      step(
        "x.refresh",
        "Add a refresh token and client id so the 2-hour access token renews itself",
        refreshToken && clientId ? "done" : refreshToken ? "error" : "todo",
        { link: portal },
      ),
      step("x.mention", `Reply to a post with "@${username ?? "your bot"} is this true?"`, "info"),
    ];
  },
  start: async (runtime) => {
    const refreshToken = config(runtime, "refreshToken");
    const clientId = config(runtime, "clientId");
    const problem =
      refreshToken && !clientId
        ? "A refresh token needs the app's OAuth2 client id too"
        : !config(runtime, "bearerToken") && !refreshToken
          ? "bearerToken (or a refresh token with the client id) is required"
          : null;
    if (problem) {
      runtime.status("error", problem);
      return () => {};
    }
    const controller = new AbortController();
    const { signal } = controller;
    let me: XUser | undefined;
    const auth = await untilAuthorized(runtime, async () => (me = await whoAmI(runtime, signal)), signal);
    const expiryNote = xAuth(runtime).refreshable ? "" : " · no refresh token: the access token stops working 2 hours after it was issued";
    if (auth.first) runtime.status("ok", `Watching mentions of @${me!.username}${expiryNote}`);
    void auth.ready.then((ok) => {
      if (ok) runtime.state.set("username", me!.username);
      if (ok) return poll(runtime, me!, signal);
    });
    return () => controller.abort();
  },
};
