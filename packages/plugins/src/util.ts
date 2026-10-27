import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/** Cut `text` to at most `max` characters, preferring a word boundary, marking the cut with "…". */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return text.slice(0, max);
  let cut = text.slice(0, max - 1);
  const space = cut.search(/\s\S*$/);
  if (space > max * 0.8) cut = cut.slice(0, space);
  return cut.trimEnd() + "…";
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—",
  hellip: "…", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", laquo: "«", raquo: "»",
  copy: "©", reg: "®", trade: "™", middot: "·", bull: "•", times: "×", euro: "€",
};

/** Single pass, so `&amp;lt;` decodes to `&lt;` rather than `<`. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

const BLOCK_TAGS =
  /<\/?(p|div|section|article|main|header|h[1-6]|ul|ol|tr|table|blockquote|pre|dl|dt|dd|figure|figcaption|hr|address)\b[^>]*>/gi;

/** Readable text from HTML without a DOM: drops chrome (scripts, nav, footer…), keeps paragraph breaks. */
export function htmlToText(html: string): { title: string; text: string } {
  const title = collapse(decodeEntities(stripTags(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "")));
  let body = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg|template|head|iframe|canvas|nav|footer|form|aside|select)\b[\s\S]*?<\/\1\s*>/gi, " ");
  // Prefer the main content region when the page marks one and it has substance.
  const main = /<(main|article)\b[^>]*>([\s\S]*)<\/\1\s*>/i.exec(body)?.[2];
  if (main && stripTags(main).trim().length > 200) body = main;
  const text = decodeEntities(
    stripTags(
      body
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<li\b[^>]*>/gi, "\n- ")
        .replace(/<\/t[dh]\s*>/gi, " ")
        .replace(BLOCK_TAGS, "\n"),
    ),
  )
    .split("\n")
    .map(collapse)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, text };
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, "");
}

function collapse(text: string): string {
  return text.replace(/[\s ]+/g, " ").trim();
}

/** Resolves after `ms`, or as soon as `signal` aborts (never rejects). */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
  });
}

/** Exponential backoff with full jitter: attempt 0 → up to 1s, capped at `maxMs`. */
export function backoff(attempt: number, maxMs = 60_000): number {
  return Math.round(Math.random() * Math.min(maxMs, 1000 * 2 ** attempt)) + 250;
}

export function hmacSha256Hex(key: string, data: string): string {
  return createHmac("sha256", key).update(data).digest("hex");
}

export function sha256Hex(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Constant-time string comparison (length leak only). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** True when `text` contains `@handle` as a standalone mention. */
export function mentionsHandle(text: string, handle: string): boolean {
  if (!handle) return false;
  const escaped = handle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w@])@${escaped}(?![\\w])`, "i").test(text);
}

// ─── SSRF guard ─────────────────────────────────────────────────────────────

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, part) => acc * 256 + Number(part), 0);
}

const PRIVATE_V4: [string, number][] = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];

export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const n = ipv4ToInt(ip);
    return PRIVATE_V4.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      return ((n & mask) >>> 0) === ((ipv4ToInt(base) & mask) >>> 0);
    });
  }
  if (isIP(ip) !== 6) return true;
  const v6 = ip.toLowerCase();
  // IPv4-mapped / NAT64 forms carry an IPv4 address that must be checked itself.
  const embedded = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(v6)?.[1];
  if (embedded) return isPrivateAddress(embedded);
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v6);
  if (mapped) {
    const hi = parseInt(mapped[1]!, 16);
    const lo = parseInt(mapped[2]!, 16);
    return isPrivateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return (
    v6 === "::" || v6 === "::1" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith("ff") ||
    v6.startsWith("2001:db8")
  );
}

/**
 * Throws unless `raw` is an http(s) URL whose host resolves only to public addresses.
 * DNS is resolved here and again by fetch, so a rebinding attacker could still race it;
 * this stops the common cases (localhost, metadata endpoints, LAN hosts).
 */
export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`Only http(s) URLs are allowed`);
  await resolvePublicHost(url.hostname);
  return url;
}

/** Addresses `hostname` resolves to; throws if it names a private host or any address is private. */
export async function resolvePublicHost(hostname: string): Promise<string[]> {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
    throw new Error(`Refusing to fetch private host ${host}`);
  }
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new Error(`Refusing to fetch private host ${host}`);
  }
  return addresses;
}

/** fetch that re-checks every redirect hop against the SSRF guard. */
export async function fetchPublic(
  fetchFn: typeof fetch,
  raw: string,
  init: RequestInit = {},
  maxRedirects = 5,
): Promise<Response> {
  let url = await assertPublicUrl(raw);
  for (let hop = 0; ; hop++) {
    const res = await fetchFn(url, { ...init, redirect: "manual" });
    const location = res.headers.get("location");
    if (res.status < 300 || res.status >= 400 || !location) return res;
    await res.body?.cancel();
    if (hop >= maxRedirects) throw new Error(`Too many redirects`);
    url = await assertPublicUrl(new URL(location, url).toString());
  }
}

/** Read at most `maxBytes` of a response body as text (charset from Content-Type, default UTF-8). */
export async function readTextCapped(res: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const charset = /charset=([^;]+)/i.exec(res.headers.get("content-type") ?? "")?.[1]?.trim().replace(/"/g, "");
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset || "utf-8");
  } catch {
    decoder = new TextDecoder("utf-8");
  }
  if (!res.body) return { text: "", truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    if (size >= maxBytes) {
      truncated = true;
      await reader.cancel();
      break;
    }
  }
  const bytes = Buffer.concat(chunks).subarray(0, maxBytes);
  return { text: decoder.decode(bytes), truncated };
}
