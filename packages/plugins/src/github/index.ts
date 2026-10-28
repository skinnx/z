import { definePlugin, defineTool, type BriefSourceItem } from "@z/core";
import { z } from "zod";
import { truncate } from "../util.ts";

const API = "https://api.github.com";

type Fetcher = { fetch: typeof fetch; settings: Record<string, string>; signal?: AbortSignal };

async function gh<T>(ctx: Fetcher, path: string, init: RequestInit = {}, needsToken = true): Promise<T> {
  const token = ctx.settings.token;
  if (needsToken && !token) throw new Error("GitHub token is not configured in the GitHub plugin settings.");
  const res = await ctx.fetch(API + path, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "z-agent",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  if (!res.ok) {
    const detail = ((await res.json().catch(() => ({}))) as { message?: string }).message ?? res.statusText;
    throw new Error(`GitHub ${res.status}: ${detail}`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

type Notification = {
  id: string;
  reason: string;
  unread: boolean;
  updated_at: string;
  subject: { title: string; type: string; url: string | null };
  repository: { full_name: string; html_url: string };
};

type Issue = {
  number: number;
  title: string;
  state: string;
  html_url: string;
  comments: number;
  updated_at: string;
  user: { login: string } | null;
  repository_url: string;
  pull_request?: unknown;
  body?: string | null;
};

/** Notification subjects carry API URLs; map them to the page a human would open. */
export function subjectHtmlUrl(n: Notification): string {
  const api = n.subject.url;
  if (!api) return n.repository.html_url;
  if (/\/releases\/\d+$/.test(api)) return `${n.repository.html_url}/releases`;
  return api
    .replace(`${API}/repos/`, "https://github.com/")
    .replace(/\/pulls\/(\d+)$/, "/pull/$1")
    .replace(/\/commits\/([0-9a-f]+)$/, "/commit/$1");
}

function notificationView(n: Notification) {
  return {
    id: n.id,
    reason: n.reason,
    type: n.subject.type,
    title: n.subject.title,
    repo: n.repository.full_name,
    url: subjectHtmlUrl(n),
    unread: n.unread,
    updatedAt: n.updated_at,
  };
}

function issueView(i: Issue) {
  return {
    repo: i.repository_url.replace(`${API}/repos/`, ""),
    number: i.number,
    title: i.title,
    state: i.state,
    isPullRequest: Boolean(i.pull_request),
    author: i.user?.login ?? null,
    comments: i.comments,
    updatedAt: i.updated_at,
    url: i.html_url,
  };
}

const Repo = z.string().regex(/^[\w.-]+\/[\w.-]+$/, "Use owner/name");

function repoPath(repo: string): string {
  const [owner, name] = repo.split("/") as [string, string];
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

const listNotifications = defineTool({
  description: "List your GitHub notifications (unread by default).",
  risk: "read",
  inputSchema: z.object({
    all: z.boolean().default(false).describe("Include notifications already read"),
    participating: z.boolean().default(false).describe("Only threads you participate in or are mentioned in"),
    limit: z.number().int().min(1).max(50).default(20),
  }),
  execute: async ({ all, participating, limit }, ctx) => {
    const q = new URLSearchParams({ all: String(all), participating: String(participating), per_page: String(limit) });
    const list = await gh<Notification[]>(ctx, `/notifications?${q}`);
    return { notifications: list.map(notificationView) };
  },
});

const searchIssues = defineTool({
  description:
    "Search GitHub issues and pull requests with GitHub search syntax, e.g. `repo:owner/name is:open label:bug` or `is:pr review-requested:@me`. Works without a token for public repositories (lower rate limit, no @me).",
  risk: "read",
  inputSchema: z.object({
    query: z.string().min(1).max(256),
    limit: z.number().int().min(1).max(50).default(10),
  }),
  execute: async ({ query, limit }, ctx) => {
    const q = new URLSearchParams({ q: query, per_page: String(limit) });
    const data = await gh<{ total_count: number; items: Issue[] }>(ctx, `/search/issues?${q}`, {}, false);
    return { total: data.total_count, items: data.items.map(issueView) };
  },
});

const createIssue = defineTool({
  description: "Open a new issue in a GitHub repository.",
  risk: "external",
  inputSchema: z.object({
    repo: Repo,
    title: z.string().min(1).max(256),
    body: z.string().max(60_000).optional(),
    labels: z.array(z.string()).max(20).optional(),
  }),
  summarize: ({ repo, title }) => `Open issue "${truncate(title, 80)}" in ${repo}`,
  execute: async ({ repo, title, body, labels }, ctx) => {
    const issue = await gh<Issue>(ctx, `${repoPath(repo)}/issues`, {
      method: "POST",
      body: JSON.stringify({ title, body, labels }),
    });
    return { number: issue.number, url: issue.html_url };
  },
});

const comment = defineTool({
  description: "Comment on a GitHub issue or pull request.",
  risk: "external",
  inputSchema: z.object({
    repo: Repo,
    number: z.number().int().positive(),
    body: z.string().min(1).max(60_000),
  }),
  summarize: ({ repo, number, body }) => `Comment on ${repo}#${number}: "${truncate(body.replace(/\s+/g, " "), 80)}"`,
  execute: async ({ repo, number, body }, ctx) => {
    const created = await gh<{ id: number; html_url: string }>(ctx, `${repoPath(repo)}/issues/${number}/comments`, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
    return { id: created.id, url: created.html_url };
  },
});

/** GitHub App accounts end in `[bot]`; their pull requests are dependency bumps and other upkeep. */
const isBot = (login: string | null) => Boolean(login?.endsWith("[bot]"));

/**
 * Only what the notification says for certain: read already, or a workflow run that succeeded
 * ("CI workflow run succeeded for main branch"). Failed and cancelled runs are left for triage to read.
 */
function notificationSignals(n: ReturnType<typeof notificationView>): Pick<BriefSourceItem, "signals"> {
  const signals = {
    ...(n.unread ? {} : { read: true }),
    ...(n.reason === "ci_activity" && /\bworkflow run succeeded\b/i.test(n.title) ? { ciPassed: true } : {}),
  };
  return Object.keys(signals).length ? { signals } : {};
}

const TODO_REASONS = new Set(["review_requested", "mention", "team_mention", "assign", "approval_requested"]);

export default definePlugin({
  id: "github",
  name: "GitHub",
  description: "Notifications, review requests and issues. Search works without a token for public repositories.",
  settings: [{ key: "token", label: "Personal access token (notifications, repo)", secret: true }],
  tools: {
    list_notifications: listNotifications,
    search_issues: searchIssues,
    create_issue: createIssue,
    comment,
  },
  briefing: async (ctx) => {
    if (!ctx.settings.token) return [];
    const items: BriefSourceItem[] = [];
    const seen = new Set<string>();
    const reviews = await gh<{ items: Issue[] }>(ctx, `/search/issues?${new URLSearchParams({
      q: "is:open is:pr review-requested:@me archived:false",
      per_page: "20",
    })}`);
    for (const pr of reviews.items) {
      const v = issueView(pr);
      seen.add(v.url);
      items.push({
        id: `github:review:${v.repo}#${v.number}`,
        source: "github",
        kind: "todo",
        text: `Review requested: ${v.repo}#${v.number} ${truncate(v.title, 160)}${v.author ? ` (by @${v.author})` : ""}`,
        url: v.url,
        suggestion: `Summarize ${v.repo}#${v.number} and the open review threads`,
        ...(isBot(v.author) ? { signals: { bot: true } } : {}),
      });
    }
    const q = new URLSearchParams({ since: ctx.since.toISOString(), per_page: "50" });
    for (const n of (await gh<Notification[]>(ctx, `/notifications?${q}`)).map(notificationView)) {
      if (seen.has(n.url)) continue;
      seen.add(n.url);
      items.push({
        id: `github:notification:${n.id}`,
        source: "github",
        kind: TODO_REASONS.has(n.reason) ? "todo" : "followup",
        text: `${n.repo}: ${truncate(n.title, 160)} (${n.reason.replace(/_/g, " ")})`,
        url: n.url,
        ...notificationSignals(n),
      });
    }
    return items.slice(0, 40);
  },
});
