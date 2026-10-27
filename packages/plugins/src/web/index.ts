import { definePlugin, defineTool, type ToolContext } from "@z/core";
import { z } from "zod";
import { fetchPublic, htmlToText, readTextCapped, truncate } from "../util.ts";
import { hackerNews, lookUp, wikidata, wikipedia } from "./facts.ts";

type SearchResult = { title: string; url: string; snippet: string };

async function tavily(ctx: ToolContext, apiKey: string, query: string, limit: number): Promise<SearchResult[]> {
  const res = await ctx.fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ query, max_results: limit, search_depth: "basic" }),
    signal: ctx.signal,
  });
  if (!res.ok) throw new Error(`Tavily search failed: HTTP ${res.status}`);
  const data = (await res.json()) as { results?: { title?: string; url: string; content?: string }[] };
  return (data.results ?? []).map((r) => ({ title: r.title ?? r.url, url: r.url, snippet: r.content ?? "" }));
}

async function brave(ctx: ToolContext, apiKey: string, query: string, limit: number): Promise<SearchResult[]> {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(limit));
  const res = await ctx.fetch(url, {
    headers: { accept: "application/json", "x-subscription-token": apiKey },
    signal: ctx.signal,
  });
  if (!res.ok) throw new Error(`Brave search failed: HTTP ${res.status}`);
  const data = (await res.json()) as { web?: { results?: { title?: string; url: string; description?: string }[] } };
  return (data.web?.results ?? []).map((r) => ({
    title: r.title ?? r.url,
    url: r.url,
    // Brave wraps matched terms in <strong>.
    snippet: htmlToText(r.description ?? "").text,
  }));
}

/** SearXNG is self-hosted by the user, so its base URL may legitimately be on the LAN. */
async function searxng(ctx: ToolContext, base: string, query: string, limit: number): Promise<SearchResult[]> {
  const url = new URL("search", base.endsWith("/") ? base : base + "/");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  const res = await ctx.fetch(url, { headers: { accept: "application/json" }, signal: ctx.signal });
  if (!res.ok) {
    const hint = res.status === 403 ? " (enable the json format under search.formats in settings.yml)" : "";
    throw new Error(`SearXNG search failed: HTTP ${res.status}${hint}`);
  }
  const data = (await res.json()) as { results?: { title?: string; url: string; content?: string }[] };
  return (data.results ?? [])
    .slice(0, limit)
    .map((r) => ({ title: r.title ?? r.url, url: r.url, snippet: r.content ?? "" }));
}

const search = defineTool({
  description:
    "Search the web: titles, URLs and snippets (read one with fetch_page). Without a configured backend it searches English Wikipedia.",
  risk: "read",
  public: true,
  inputSchema: z.object({
    query: z.string().min(1).max(400),
  }),
  execute: async ({ query }, ctx) => {
    const limit = 8;
    const { tavilyApiKey, braveApiKey, searxngUrl } = ctx.settings;
    let provider: string;
    let results: SearchResult[];
    if (tavilyApiKey) [provider, results] = ["tavily", await tavily(ctx, tavilyApiKey, query, limit)];
    else if (braveApiKey) [provider, results] = ["brave", await brave(ctx, braveApiKey, query, limit)];
    else if (searxngUrl) [provider, results] = ["searxng", await searxng(ctx, searxngUrl, query, limit)];
    // Keyless fallback so search always works: Wikipedia, with the best article already read.
    else return { provider: "wikipedia", ...(await lookUp(ctx, query, query, "en", 1500)) };
    return {
      provider,
      results: results.map((r) => ({ title: truncate(r.title, 200), url: r.url, snippet: truncate(r.snippet, 400) })),
    };
  },
});

const MAX_BYTES = 2_000_000;

const fetchPage = defineTool({
  description: "Fetch a public web page and return its title and readable text.",
  risk: "read",
  public: true,
  inputSchema: z.object({
    url: z.string().min(1),
    maxChars: z.number().int().min(500).max(20_000).default(8000),
  }),
  execute: async ({ url, maxChars }, ctx) => {
    const res = await fetchPublic(ctx.fetch, url, {
      headers: {
        accept: "text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.8,*/*;q=0.1",
        "user-agent": "Mozilla/5.0 (compatible; z/0.1; +https://github.com/skinnx/z)",
      },
      signal: ctx.signal,
    });
    if (!res.ok) throw new Error(`Fetching ${url} failed: HTTP ${res.status}`);
    const type = (res.headers.get("content-type") ?? "").toLowerCase();
    const isHtml = type.includes("html") || type.includes("xml");
    if (type && !isHtml && !type.startsWith("text/") && !type.includes("json")) {
      await res.body?.cancel();
      throw new Error(`Unsupported content type ${type.split(";")[0]}`);
    }
    const body = await readTextCapped(res, MAX_BYTES);
    const page = isHtml || !type ? htmlToText(body.text) : { title: "", text: body.text.trim() };
    const text = truncate(page.text, maxChars);
    return {
      url: res.url || url,
      title: page.title,
      text,
      truncated: body.truncated || text.length < page.text.length,
    };
  },
});

export default definePlugin({
  id: "web",
  name: "Web",
  description:
    "Search the web (Tavily, Brave Search or SearXNG), read pages, and look things up keylessly on Wikipedia, Wikidata and Hacker News.",
  settings: [
    { key: "tavilyApiKey", label: "Tavily API key", secret: true },
    { key: "braveApiKey", label: "Brave Search API key", secret: true },
    { key: "searxngUrl", label: "SearXNG base URL (e.g. http://localhost:8080)" },
  ],
  tools: { search, fetch_page: fetchPage, wikipedia, wikidata, hacker_news: hackerNews },
});
