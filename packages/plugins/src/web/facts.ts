/**
 * Keyless grounding sources: Wikipedia, Wikidata and Hacker News (Algolia).
 * Wikimedia asks API clients to identify themselves with a descriptive User-Agent
 * and a way to reach the operator, and to keep request rates modest; responses are
 * cached briefly in memory so a burst of similar questions doesn't hit the APIs twice.
 */
import { defineTool, type ToolContext } from "@z/core";
import { z } from "zod";
import { decodeEntities, sleep, truncate } from "../util.ts";

export const USER_AGENT = "z/0.1 (https://github.com/skinnx/z; self-hosted open-source agent) z-web-plugin";

const TTL_MS = 10 * 60_000;
const MAX_ENTRIES = 500;
const cache = new Map<string, { at: number; value: unknown }>();

async function getJson<T>(ctx: ToolContext, url: URL, label: string): Promise<T> {
  const key = url.toString();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value as T;
  const request = () =>
    ctx.fetch(url, {
      headers: { accept: "application/json", "user-agent": USER_AGENT, "api-user-agent": USER_AGENT },
      signal: ctx.signal,
    });
  let res = await request();
  // One polite retry when the API asks for a short pause; otherwise back off to other sources.
  const retryAfter = Number(res.headers.get("retry-after"));
  if (res.status === 429 && retryAfter > 0 && retryAfter <= 3) {
    await res.body?.cancel();
    await sleep(retryAfter * 1000, ctx.signal);
    res = await request();
  }
  if (res.status === 429) {
    await res.body?.cancel();
    throw new Error(`${label} is rate limiting requests right now; use another source`);
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`${label} request failed: HTTP ${res.status}`);
  }
  const value = (await res.json()) as T;
  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  cache.set(key, { at: Date.now(), value });
  return value;
}

const plain = (html: string) => decodeEntities(html.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();

const Lang = z
  .string()
  .regex(/^[a-z]{2,3}(-[a-z]+)?$/)
  .default("en")
  .describe("Language of the claim, e.g. en, vi");

// ─── Wikipedia ──────────────────────────────────────────────────────────────

type WikiHit = { title: string; url: string; snippet: string; description?: string };

export async function wikipediaSearch(ctx: ToolContext, query: string, lang: string, limit: number): Promise<WikiHit[]> {
  const url = new URL(`https://${lang}.wikipedia.org/w/rest.php/v1/search/page`);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(limit));
  const data = await getJson<{ pages?: { key: string; title: string; excerpt?: string; description?: string | null }[] }>(
    ctx,
    url,
    "Wikipedia",
  );
  return (data.pages ?? []).map((p) => ({
    title: p.title,
    url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(p.key)}`,
    snippet: plain(p.excerpt ?? ""),
    ...(p.description ? { description: p.description } : {}),
  }));
}

/** Plain-text article extract (TextExtracts), following redirects. */
async function wikipediaExtract(ctx: ToolContext, title: string, lang: string) {
  const url = new URL(`https://${lang}.wikipedia.org/w/api.php`);
  for (const [k, v] of Object.entries({
    action: "query",
    prop: "extracts|info",
    explaintext: "1",
    exsectionformat: "plain",
    inprop: "url",
    redirects: "1",
    titles: title,
    format: "json",
    formatversion: "2",
  })) {
    url.searchParams.set(k, v);
  }
  const data = await getJson<{
    query?: { pages?: { title: string; missing?: boolean; extract?: string; fullurl?: string; touched?: string }[] };
  }>(ctx, url, "Wikipedia");
  const page = data.query?.pages?.[0];
  if (!page || page.missing || !page.extract) return null;
  return { title: page.title, url: page.fullurl ?? `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(page.title)}`, text: page.extract, touched: page.touched };
}

const STOP = new Set(
  "the a an of and or to in on at for is are was were be been by with from that this it as not no do does did has have had its into than then".split(" "),
);
const terms = (text: string) =>
  [...new Set(text.toLowerCase().normalize("NFC").split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1 && !STOP.has(w)))];

/**
 * The lead paragraph plus the paragraphs that best match `focus`, in article order, so a long
 * article still yields the part that answers the question within `maxChars`. Terms are weighted
 * by rarity across the article: "moon" beats "wall" in the Great Wall article.
 */
export function focusText(text: string, focus: string | undefined, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const paragraphs = text.split(/\n+/).map((p) => p.trim()).filter(Boolean);
  const want = terms(focus ?? "");
  if (!want.length || paragraphs.length < 2) return truncate(text, maxChars);
  const words = paragraphs.map((p) => new Set(terms(p)));
  const weight = new Map(
    want.map((w) => [w, Math.log((paragraphs.length + 1) / (words.filter((ws) => ws.has(w)).length + 0.5))]),
  );
  const scored = paragraphs
    .map((p, i) => ({ i, p, score: want.reduce((sum, w) => sum + (words[i]!.has(w) ? weight.get(w)! : 0), 0) }))
    .filter((x) => x.i > 0 && x.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i);
  const picked = [{ i: 0, p: truncate(paragraphs[0]!, Math.round(maxChars / 3)) }];
  let used = picked[0]!.p.length;
  for (const x of scored) {
    const p = truncate(x.p, Math.min(800, maxChars - used));
    if (used + p.length + 5 > maxChars) continue;
    picked.push({ i: x.i, p });
    used += p.length + 5;
  }
  picked.sort((a, b) => a.i - b.i);
  return picked.map((x, n) => (n > 0 && x.i !== picked[n - 1]!.i + 1 ? `…\n${x.p}` : x.p)).join("\n");
}

export const wikipedia = defineTool({
  description:
    "Look up Wikipedia: returns the best-matching article's lead plus its paragraphs most relevant to `focus`, and other matching titles. For people, places, history, science, settled facts.",
  risk: "read",
  public: true,
  inputSchema: z.object({
    query: z.string().min(1).max(300).describe("Search terms or an article title"),
    focus: z.string().max(300).optional().describe("The specific claim or detail you need"),
    lang: Lang,
  }),
  execute: ({ query, focus, lang }, ctx) => lookUp(ctx, query, focus ?? query, lang, 2000),
});

/** Search Wikipedia and read the best hit, focused on what the question needs. */
export async function lookUp(ctx: ToolContext, query: string, focus: string, lang: string, maxChars: number) {
  const hits = await wikipediaSearch(ctx, query, lang, 5);
  const exact = hits.find((h) => h.title.toLowerCase() === query.trim().toLowerCase());
  const best = exact ?? hits[0];
  const article = best ? await wikipediaExtract(ctx, best.title, lang) : null;
  return {
    article: article
      ? { title: article.title, url: article.url, lastEdited: article.touched, text: focusText(article.text, focus, maxChars) }
      : null,
    otherResults: hits
      .filter((h) => h !== best)
      .map((h) => ({ title: h.title, url: h.url, ...(h.description ? { description: h.description } : {}) })),
  };
}

// ─── Wikidata ───────────────────────────────────────────────────────────────

type Snak = { snaktype: string; property: string; datavalue?: { type: string; value: any } };
type Claim = { mainsnak: Snak; rank: "preferred" | "normal" | "deprecated"; qualifiers?: Record<string, Snak[]> };
type Entity = {
  id: string;
  labels?: Record<string, { value: string }>;
  descriptions?: Record<string, { value: string }>;
  claims?: Record<string, Claim[]>;
  sitelinks?: Record<string, { title: string }>;
};

const WIKIDATA = "https://www.wikidata.org/w/api.php";
/** Point-in-time, start time, end time: the qualifiers that make a statement checkable. */
const TIME_QUALIFIERS = ["P585", "P580", "P582"];
/** Wiki housekeeping (categories, lists, "described by source", focus lists) rather than facts. */
const NOISE = new Set(["P910", "P1465", "P1343", "P5008", "P7867", "P2354", "P1424", "P3876", "P8989", "P1151", "P7561"]);

async function entities(ctx: ToolContext, ids: string[], props: string, lang: string): Promise<Record<string, Entity>> {
  const out: Record<string, Entity> = {};
  for (let i = 0; i < ids.length; i += 50) {
    const url = new URL(WIKIDATA);
    for (const [k, v] of Object.entries({
      action: "wbgetentities",
      ids: ids.slice(i, i + 50).join("|"),
      props,
      languages: lang === "en" ? "en" : `${lang}|en`,
      format: "json",
    })) {
      url.searchParams.set(k, v);
    }
    Object.assign(out, (await getJson<{ entities?: Record<string, Entity> }>(ctx, url, "Wikidata")).entities ?? {});
  }
  return out;
}

const label = (e: Entity | undefined, lang: string) => e?.labels?.[lang]?.value ?? e?.labels?.en?.value;

function formatTime(value: { time: string; precision: number }): string {
  const [, sign, y, m, d] = /^([+-])(\d+)-(\d\d)-(\d\d)/.exec(value.time) ?? [];
  if (!y) return value.time;
  const year = `${sign === "-" ? "-" : ""}${Number(y)}`;
  if (value.precision >= 11) return `${year}-${m}-${d}`;
  if (value.precision === 10) return `${year}-${m}`;
  return year;
}

function formatValue(snak: Snak, labels: (id: string) => string): string | null {
  const dv = snak.datavalue;
  if (snak.snaktype !== "value" || !dv) return snak.snaktype === "novalue" ? "none" : null;
  switch (dv.type) {
    case "wikibase-entityid":
      return labels(dv.value.id);
    case "time":
      return formatTime(dv.value);
    case "quantity": {
      const unit = String(dv.value.unit ?? "");
      const amount = String(dv.value.amount).replace(/^\+/, "");
      const unitId = /Q\d+$/.exec(unit)?.[0];
      return unitId ? `${amount} ${labels(unitId)}` : amount;
    }
    case "monolingualtext":
      return dv.value.text;
    case "globecoordinate":
      return `${dv.value.latitude}, ${dv.value.longitude}`;
    case "string":
      return String(dv.value);
    default:
      return null;
  }
}

export const wikidata = defineTool({
  description:
    "Structured facts from Wikidata: an entity's statements (population, dates, heights, office holders…) with point-in-time qualifiers. For numbers and dates.",
  risk: "read",
  public: true,
  inputSchema: z.object({
    query: z.string().min(1).max(200).describe("Entity name, e.g. Mount Everest"),
    lang: Lang,
  }),
  execute: async ({ query, lang }, ctx) => {
    const url = new URL(WIKIDATA);
    for (const [k, v] of Object.entries({ action: "wbsearchentities", search: query, language: lang, uselang: lang, type: "item", limit: "3", format: "json" })) {
      url.searchParams.set(k, v);
    }
    const found = await getJson<{ search?: { id: string; label?: string; description?: string }[] }>(ctx, url, "Wikidata");
    const top = found.search?.[0];
    if (!top) return { entity: null, otherMatches: [] };

    const entity = (await entities(ctx, [top.id], "labels|descriptions|claims|sitelinks", lang))[top.id];
    const claims = Object.entries(entity?.claims ?? {})
      .filter(([pid]) => !NOISE.has(pid))
      // Identifiers (external ids, media, URLs) are noise for fact checking.
      .map(([pid, list]) => [pid, list.filter((c) => c.rank !== "deprecated" && ["wikibase-entityid", "time", "quantity", "monolingualtext", "globecoordinate"].includes(c.mainsnak.datavalue?.type ?? ""))] as const)
      .filter(([, list]) => list.length > 0)
      .slice(0, 30);

    const ids = new Set<string>();
    for (const [pid, list] of claims) {
      ids.add(pid);
      for (const c of list.slice(0, 3)) {
        const snaks = [c.mainsnak, ...TIME_QUALIFIERS.flatMap((q) => c.qualifiers?.[q] ?? [])];
        for (const s of snaks) {
          if (s.datavalue?.type === "wikibase-entityid") ids.add(s.datavalue.value.id);
          const unit = /Q\d+$/.exec(String(s.datavalue?.value?.unit ?? ""))?.[0];
          if (unit) ids.add(unit);
        }
      }
      for (const q of TIME_QUALIFIERS) ids.add(q);
    }
    const labelled = await entities(ctx, [...ids], "labels", lang);
    const labels = (id: string) => label(labelled[id], lang) ?? id;

    const statements: Record<string, string[]> = {};
    for (const [pid, list] of claims) {
      // Preferred-rank statements are the current value (e.g. latest population) when present.
      const preferred = list.filter((c) => c.rank === "preferred");
      const values = (preferred.length ? preferred : list).slice(0, 3).flatMap((c) => {
        const value = formatValue(c.mainsnak, labels);
        if (!value) return [];
        const when = TIME_QUALIFIERS.flatMap((q) =>
          (c.qualifiers?.[q] ?? []).map((s) => `${labels(q)} ${formatValue(s, labels)}`),
        );
        return [when.length ? `${value} (${when.join(", ")})` : value];
      });
      if (values.length) statements[`${labels(pid)} (${pid})`] = values;
    }
    const wikiTitle = entity?.sitelinks?.[`${lang}wiki`]?.title ?? entity?.sitelinks?.enwiki?.title;
    return {
      entity: {
        id: top.id,
        label: label(entity, lang) ?? top.label ?? top.id,
        description: entity?.descriptions?.[lang]?.value ?? entity?.descriptions?.en?.value ?? top.description ?? "",
        url: `https://www.wikidata.org/wiki/${top.id}`,
        ...(wikiTitle
          ? { wikipedia: `https://${entity?.sitelinks?.[`${lang}wiki`] ? lang : "en"}.wikipedia.org/wiki/${encodeURIComponent(wikiTitle.replaceAll(" ", "_"))}` }
          : {}),
        statements,
      },
      otherMatches: (found.search ?? []).slice(1).map((s) => ({ id: s.id, label: s.label, description: s.description })),
    };
  },
});

// ─── Hacker News (Algolia) ──────────────────────────────────────────────────

export const hackerNews = defineTool({
  description:
    "Search Hacker News stories for tech news, launches, outages and announcements: titles, linked URLs, points, dates.",
  risk: "read",
  public: true,
  inputSchema: z.object({
    query: z.string().min(1).max(200),
    recent: z.boolean().default(false).describe("Newest first, for breaking news"),
  }),
  execute: async ({ query, recent }, ctx) => {
    const limit = 8;
    const url = new URL(`https://hn.algolia.com/api/v1/${recent ? "search_by_date" : "search"}`);
    url.searchParams.set("query", query);
    url.searchParams.set("tags", "story");
    url.searchParams.set("hitsPerPage", String(limit));
    const data = await getJson<{
      hits?: { objectID: string; title?: string; url?: string | null; points?: number; num_comments?: number; created_at: string }[];
    }>(ctx, url, "Hacker News search");
    return {
      results: (data.hits ?? []).map((h) => ({
        title: h.title ?? "",
        url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
        discussion: `https://news.ycombinator.com/item?id=${h.objectID}`,
        points: h.points ?? 0,
        comments: h.num_comments ?? 0,
        date: h.created_at.slice(0, 10),
      })),
    };
  },
});
