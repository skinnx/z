import { definePlugin, defineTool, type BriefSourceItem } from "@z/core";
import { z } from "zod";
import { decodeEntities, errorMessage, fetchPublic, htmlToText, readTextCapped, sha256Hex, truncate } from "../util.ts";

export type FeedItem = { id: string; title: string; url?: string; published?: string; summary: string };
export type Feed = { title: string; items: FeedItem[] };

function escapeTag(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Inner text of the first `<name>` element: CDATA unwrapped, entities decoded. */
function tagText(xml: string, name: string): string {
  const tag = escapeTag(name);
  const inner = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}\\s*>`, "i").exec(xml)?.[1];
  if (inner === undefined) return "";
  // CDATA content is literal; everything outside it is entity-encoded.
  return inner
    .split(/(<!\[CDATA\[[\s\S]*?\]\]>)/)
    .map((part) => (part.startsWith("<![CDATA[") ? part.slice(9, -3) : decodeEntities(part)))
    .join("")
    .trim();
}

function blocks(xml: string, name: string): string[] {
  const tag = escapeTag(name);
  return [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}\\s*>`, "gi"))].map((m) => m[1]!);
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    out[m[1]!.toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? "");
  }
  return out;
}

function atomLink(entry: string): string | undefined {
  const links = [...entry.matchAll(/<link\b[^>]*>/gi)].map((m) => attrs(m[0]));
  const best = links.find((l) => !l.rel || l.rel === "alternate") ?? links[0];
  return best?.href || undefined;
}

function toIso(date: string): string | undefined {
  if (!date) return undefined;
  const ms = Date.parse(date);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/** Parses RSS 2.0, RSS 1.0 (RDF) and Atom without a DOM. */
export function parseFeed(xml: string): Feed {
  const atom = /<feed\b/i.test(xml) && !/<(rss|rdf:RDF)\b/i.test(xml);
  const itemTag = atom ? "entry" : "item";
  const firstItem = xml.search(new RegExp(`<${itemTag}[\\s>]`, "i"));
  const head = firstItem >= 0 ? xml.slice(0, firstItem) : xml;
  const items = blocks(xml, itemTag).map((block): FeedItem => {
    const title = htmlToText(tagText(block, "title")).text.replace(/\s+/g, " ");
    const guid = tagText(block, atom ? "id" : "guid");
    let url = atom ? atomLink(block) : tagText(block, "link") || undefined;
    if (!url && /^https?:\/\//.test(guid)) url = guid;
    const published = toIso(
      tagText(block, atom ? "published" : "pubDate") || tagText(block, "updated") || tagText(block, "dc:date"),
    );
    const rawSummary =
      tagText(block, atom ? "summary" : "description") || tagText(block, "content:encoded") || tagText(block, "content");
    return {
      id: guid || url || title,
      title: title || "(untitled)",
      ...(url ? { url } : {}),
      ...(published ? { published } : {}),
      summary: truncate(htmlToText(rawSummary).text.replace(/\s+/g, " "), 500),
    };
  });
  return { title: htmlToText(tagText(head, "title")).text, items };
}

export function feedUrls(setting: string | undefined): string[] {
  return (setting ?? "").split(/[\s,]+/).filter((u) => /^https?:\/\//i.test(u));
}

async function loadFeed(fetchFn: typeof fetch, url: string, guarded: boolean, signal?: AbortSignal): Promise<Feed> {
  const init: RequestInit = {
    headers: { accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.5" },
    ...(signal ? { signal } : {}),
  };
  // Feeds from settings are trusted (may be a LAN rss-bridge); model-supplied URLs are not.
  const res = guarded ? await fetchPublic(fetchFn, url, init) : await fetchFn(url, init);
  if (!res.ok) throw new Error(`Fetching feed ${url} failed: HTTP ${res.status}`);
  return parseFeed((await readTextCapped(res, 5_000_000)).text);
}

function newestFirst(a: FeedItem, b: FeedItem): number {
  return (b.published ?? "").localeCompare(a.published ?? "");
}

const readFeed = defineTool({
  description: "Read an RSS or Atom feed. Without a URL, reads every feed configured in the RSS plugin settings.",
  risk: "read",
  inputSchema: z.object({
    url: z.string().optional(),
    limit: z.number().int().min(1).max(50).default(10),
  }),
  execute: async ({ url, limit }, ctx) => {
    const configured = feedUrls(ctx.settings.feeds);
    const urls = url ? [url] : configured;
    if (urls.length === 0) throw new Error("No feed URL given and no feeds configured in the RSS plugin settings.");
    const feeds = await Promise.all(
      urls.map(async (u) => {
        try {
          const feed = await loadFeed(ctx.fetch, u, !configured.includes(u), ctx.signal);
          const items = feed.items.sort(newestFirst).slice(0, limit);
          return { url: u, title: feed.title, items: items.map(({ id: _id, ...item }) => item) };
        } catch (error) {
          return { url: u, error: errorMessage(error) };
        }
      }),
    );
    // Keep the whole result near the ~8k budget by trimming summaries when many feeds are read.
    const budget = Math.max(80, Math.floor(6000 / Math.max(1, urls.length * limit)));
    for (const feed of feeds) {
      if ("items" in feed && feed.items) for (const item of feed.items) item.summary = truncate(item.summary, budget);
    }
    return { feeds };
  },
});

export default definePlugin({
  id: "rss",
  name: "RSS",
  description: "Headlines from RSS and Atom feeds in your briefing.",
  settings: [{ key: "feeds", label: "Feed URLs (one per line or comma separated)", required: true, multiline: true }],
  tools: { read_feed: readFeed },
  briefing: async (ctx) => {
    const since = ctx.since.getTime();
    const items: BriefSourceItem[] = [];
    for (const url of feedUrls(ctx.settings.feeds)) {
      try {
        const feed = await loadFeed(ctx.fetch, url, false);
        const fresh = feed.items
          .filter((i) => i.published && Date.parse(i.published) > since)
          .sort(newestFirst)
          .slice(0, 5);
        for (const item of fresh) {
          items.push({
            id: `rss:${sha256Hex(url + "\n" + item.id).slice(0, 16)}`,
            source: "rss",
            kind: "headline",
            text: truncate(feed.title ? `${feed.title}: ${item.title}` : item.title, 300),
            ...(item.url ? { url: item.url } : {}),
          });
        }
      } catch (error) {
        ctx.log(`rss: ${errorMessage(error)}`);
      }
    }
    return items.slice(0, 30);
  },
});
