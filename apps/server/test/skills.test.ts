import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test } from "node:test";
import {
  buildTools,
  definePlugin,
  expandToolPatterns,
  invokedSkill,
  NARROW_LIMIT,
  offerTools,
  pluginLabels,
  rankTools,
  STARTER_SKILLS,
  type ActivePlugin,
  type Skill,
  type ZPlugin,
} from "@z/core";
import { Hono } from "hono";
import { z } from "zod";
import type { Services } from "../src/app.ts";
import { MIGRATION_COUNT, migrate } from "../src/db.ts";
import { skillRoutes } from "../src/routes/skills.ts";
import { boot, cleanup, scriptedModel, tempDir, testPlugin, until } from "./harness.ts";

const dirs: string[] = [];
const engines: { stopAll: () => void }[] = [];
afterEach(() => {
  for (const e of engines.splice(0)) e.stopAll();
  for (const d of dirs.splice(0)) cleanup(d);
});

function setup(plugins: ZPlugin[] = []) {
  const dir = tempDir();
  dirs.push(dir);
  const model = scriptedModel();
  const tools = testPlugin();
  const z = boot(dir, [tools.plugin, ...plugins], model.model);
  engines.push(z.tasks);
  return { dir, model, tools, ...z };
}

// ─── CRUD & seeding ────────────────────────────────────────────────────────

test("skills: a fresh install gets the starter skills, once", () => {
  const { dir, store, tasks } = setup();
  assert.deepEqual(store.skills.list().map((s) => s.name), ["factcheck", "summarize-url", "watch"]);
  store.skills.delete(store.skills.byName("watch")!.id);
  tasks.stopAll();
  // Restart on the same data dir: a deleted starter skill stays deleted.
  const again = boot(dir, [], scriptedModel().model);
  engines.push(again.tasks);
  assert.deepEqual(again.store.skills.list().map((s) => s.name), ["factcheck", "summarize-url"]);
});

/** How many migrations an install had right before the one that added skills. */
function beforeSkillsMigration(): number {
  for (let n = 1; n <= MIGRATION_COUNT; n++) {
    const probe = new DatabaseSync(":memory:");
    migrate(probe, n);
    const has = probe.prepare("SELECT 1 FROM sqlite_master WHERE name = 'skills'").get();
    probe.close();
    if (has) return n - 1;
  }
  throw new Error("no skills migration");
}

test("skills: an existing install upgrading gets no starter skills", () => {
  const dir = tempDir();
  dirs.push(dir);
  const old = new DatabaseSync(join(dir, "z.db"));
  migrate(old, beforeSkillsMigration());
  old.exec(`INSERT INTO providers (id, kind, label, models, enabled, created_at, updated_at) VALUES ('p', 'openai', 'P', '[]', 1, 'x', 'x')`);
  old.close();
  const z = boot(dir, [], scriptedModel().model);
  engines.push(z.tasks);
  assert.deepEqual(z.store.skills.list(), []);
});

test("skills: create, list, update, delete over HTTP; names are unique slugs", async () => {
  const { rt } = setup();
  const app = new Hono().route("/", skillRoutes({ rt } as unknown as Services));
  const call = (method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });

  const input = { name: "standup", description: "Draft my standup", instructions: "Summarise yesterday's commits.", tools: ["github_*", "github_*"] };
  const created = await call("POST", "/skills", input);
  assert.equal(created.status, 201);
  const skill = (await created.json()) as Skill;
  assert.deepEqual(skill.tools, ["github_*"], "duplicates dropped");

  assert.equal((await call("POST", "/skills", input)).status, 409, "name taken");
  assert.equal((await call("POST", "/skills", { ...input, name: "Not A Slug" })).status, 400);
  assert.equal((await call("POST", "/skills", { ...input, name: "long", instructions: "x".repeat(8001) })).status, 400, "≤ 8k instructions");
  assert.equal((await call("PUT", `/skills/${skill.id}`, { ...input, name: "factcheck" })).status, 409, "rename onto another skill");

  const updated = await call("PUT", `/skills/${skill.id}`, { ...input, description: "Draft today's standup", tools: [] });
  assert.equal(updated.status, 200);
  assert.equal(((await updated.json()) as Skill).description, "Draft today's standup");

  const list = (await (await call("GET", "/skills")).json()) as Skill[];
  assert.deepEqual(list.map((s) => s.name), ["factcheck", "standup", "summarize-url", "watch"]);
  assert.equal((await call("DELETE", `/skills/${skill.id}`)).status, 200);
  assert.equal((await call("DELETE", `/skills/${skill.id}`)).status, 404);
  assert.equal((await call("PUT", `/skills/${skill.id}`, input)).status, 404);
});

test("skills: /name at the start of a message invokes a skill; globs expand over real tool names", () => {
  const skills = STARTER_SKILLS.map((s, i) => ({ ...s, id: String(i), createdAt: "", updatedAt: "" }));
  assert.equal(invokedSkill("/factcheck the moon is made of cheese", skills)?.rest, "the moon is made of cheese");
  assert.equal(invokedSkill("  /watch\nnew nodejs releases", skills)?.skill.name, "watch");
  assert.equal(invokedSkill("/factchecker x", skills), null, "whole name only");
  assert.equal(invokedSkill("please /factcheck x", skills), null, "only at the start");
  assert.deepEqual(expandToolPatterns(["mcp_linear_*", "web_search"], ["web_search", "web_fetch_page", "mcp_linear_get_issue", "mcp_linearx_a"]), [
    "web_search",
    "mcp_linear_get_issue",
  ]);
});

// ─── Narrowing over a 150-tool synthetic catalogue ─────────────────────────

const CONNECTORS: { id: string; name: string; verbs: string[]; nouns: string[] }[] = [
  { id: "github", name: "GitHub", verbs: ["list", "get", "create", "update", "search"], nouns: ["issue", "pull_request", "repository", "branch", "commit"] },
  { id: "linear", name: "Linear", verbs: ["list", "get", "create", "update", "archive"], nouns: ["issue", "project", "cycle", "team", "comment"] },
  { id: "notion", name: "Notion", verbs: ["search", "get", "create", "update", "delete"], nouns: ["page", "database", "block", "comment", "user"] },
  { id: "slack", name: "Slack", verbs: ["list", "send", "get", "search", "delete"], nouns: ["message", "channel", "user", "reaction", "file"] },
  { id: "gmail", name: "Gmail", verbs: ["list", "get", "send", "draft", "delete"], nouns: ["message", "thread", "label", "attachment", "filter"] },
  { id: "calendar", name: "Google Calendar", verbs: ["list", "get", "create", "update", "delete"], nouns: ["event", "calendar", "attendee", "reminder", "availability"] },
];

/** Shaped like `connectorPlugin` output: plugin `mcp_<id>`, tools `mcp_<id>_<verb>_<noun>`. */
const catalogue: ZPlugin[] = CONNECTORS.map((c) =>
  definePlugin({
    id: `mcp_${c.id}`,
    name: c.name,
    description: `MCP connector ${c.name}`,
    tools: Object.fromEntries(
      c.verbs.flatMap((verb) =>
        c.nouns.map((noun) => [
          `${verb}_${noun}`,
          {
            description: `${verb[0]!.toUpperCase()}${verb.slice(1)} ${noun.replace("_", " ")}s in ${c.name}.`,
            risk: ["list", "get", "search"].includes(verb) ? ("read" as const) : ("write" as const),
            inputSchema: z.object({}),
            execute: async () => ({ ok: true }),
          },
        ]),
      ),
    ),
  }),
);
const builtins: ZPlugin[] = [
  definePlugin({
    id: "web",
    name: "Web",
    description: "Web tools",
    tools: {
      search: { description: "Search the web.", risk: "read", inputSchema: z.object({}), execute: async () => ({}) },
      fetch_page: { description: "Read a web page.", risk: "read", inputSchema: z.object({}), execute: async () => ({}) },
    },
  }),
];
const active = (plugins: ZPlugin[]): ActivePlugin[] => plugins.map((plugin) => ({ plugin, settings: {} }));
const all = active([...builtins, ...catalogue]);

function offer(request: string, policy: Record<string, "ask" | "allow" | "deny"> = {}) {
  const built = buildTools(all, { policy });
  const result = offerTools(built, { request, labels: pluginLabels(all) });
  return { ...result, connector: result.offered.filter((n) => n.startsWith("mcp_")) };
}

test("narrowing: the catalogue has 150 connector tools", () => {
  assert.equal(buildTools(active(catalogue), { policy: {} }) && Object.keys(buildTools(active(catalogue), { policy: {} }).tools).length, 150);
});

test("narrowing: a request is offered every built-in plus the connector tools that match it", () => {
  const cases: [string, string][] = [
    ["Create a Linear issue for the login bug", "mcp_linear_create_issue"],
    ["Send a message to #general on Slack saying the deploy is done", "mcp_slack_send_message"],
    ["What's on my calendar tomorrow? List my events", "mcp_calendar_list_event"],
    ["Find the Notion page about onboarding", "mcp_notion_search_page"],
    ["Draft an email reply in Gmail to the thread from Ana", "mcp_gmail_draft_thread"],
    ["Which pull requests are open on GitHub?", "mcp_github_list_pull_request"],
  ];
  for (const [request, expected] of cases) {
    const o = offer(request);
    assert.ok(o.narrowed, request);
    assert.ok(o.offered.includes("web_search") && o.offered.includes("web_fetch_page"), `${request}: built-ins always offered`);
    assert.ok(o.connector.includes(expected), `${request}: offers ${expected} (got ${o.connector.join(", ")})`);
    assert.ok(o.connector.length <= NARROW_LIMIT, `${request}: at most ${NARROW_LIMIT} connector tools`);
    assert.equal(o.catalogue.length, 152, "the fallback is the whole catalogue");
  }
  // The best match comes first, and ranking is deterministic.
  const connectorInfo = all.flatMap(({ plugin }) =>
    plugin.id.startsWith("mcp_") ? Object.entries(plugin.tools!).map(([k, t]) => ({ name: `${plugin.id}_${k}`, pluginId: plugin.id, description: t.description, label: plugin.name })) : [],
  );
  const ranked = rankTools("Create a Linear issue for the login bug", connectorInfo);
  assert.equal(ranked[0]!.name, "mcp_linear_create_issue");
  assert.deepEqual(ranked, rankTools("Create a Linear issue for the login bug", connectorInfo));
  // Naming one app keeps the others out.
  assert.ok(offer("Create a Linear issue for the login bug").connector.every((n) => !n.startsWith("mcp_gmail_")));
});

test("narrowing: a request that matches no connector tool is offered the built-ins only", () => {
  const o = offer("What time is it in Hanoi?");
  assert.deepEqual(o.connector, []);
  assert.deepEqual(o.offered, ["web_search", "web_fetch_page"]);
});

test("narrowing: never widens past the approval policy (deny still hides)", () => {
  const o = offer("Create a Linear issue for the login bug", { mcp_linear_create_issue: "deny" });
  assert.ok(!o.offered.includes("mcp_linear_create_issue"));
  assert.ok(!o.catalogue.includes("mcp_linear_create_issue"), "not in the fallback either");
});

test("narrowing: a call to a tool that was not offered widens the next step to the whole catalogue, once", async () => {
  const { model, store, tasks } = setup(catalogue);
  model.push(
    { call: "mcp_github_get_commit", input: {} },
    { call: "mcp_github_get_commit", input: {} },
    { text: "The latest commit is green." },
  );
  const task = tasks.create({ instructions: "Tell Ana the build is green", lane: "agent", mode: "do", missedPolicy: "once", tools: undefined });
  await until(() => model.pending() === 0 && !["queued", "running"].includes(store.tasks.get(task.id)!.status), "task to finish");

  const offered = model.model.doGenerateCalls.map((c) => (c.tools ?? []).map((t) => t.name));
  assert.ok(!offered[0]!.includes("mcp_github_get_commit"), "first step: narrowed");
  assert.ok(offered[0]!.includes("test_send") && offered[0]!.includes("report_failure"), "built-ins and run tools stay");
  assert.ok(offered[1]!.includes("mcp_github_get_commit"), "after the miss: the whole catalogue");
  assert.ok(offered[1]!.length > 150);
  const events = store.tasks.get(task.id)!.events.filter((e) => e.type === "tool");
  assert.deepEqual(events.map((e) => e.type === "tool" && e.tool), ["mcp_github_get_commit"], "the retried call ran");
});

test("narrowing: an invoked skill restricts the run to the skill's tools", async () => {
  const { model, store, tasks } = setup(catalogue);
  store.skills.save("s1", { name: "triage", description: "Triage Linear", instructions: "Look at new Linear issues.", tools: ["mcp_linear_*_issue", "nope_*"] });
  model.push({ text: "Nothing new to triage." });
  const task = tasks.create({ instructions: "/triage anything from Ana?", lane: "agent", mode: "do", missedPolicy: "once" });
  await until(() => model.pending() === 0 && !["queued", "running"].includes(store.tasks.get(task.id)!.status), "task to finish");

  const call = model.model.doGenerateCalls[0]!;
  const names = (call.tools ?? []).map((t) => t.name).filter((n) => !["report_failure", "no_update", "ask_person"].includes(n));
  assert.deepEqual(names.sort(), ["mcp_linear_archive_issue", "mcp_linear_create_issue", "mcp_linear_get_issue", "mcp_linear_list_issue", "mcp_linear_update_issue"]);
  const system = JSON.stringify(call.prompt);
  assert.ok(system.includes("Look at new Linear issues."), "the skill's instructions are in the prompt");
});
