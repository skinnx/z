/**
 * The setup checklist: what z needs to be useful and safe, each row computed from a real check.
 * A model is ready only once it answered a live test; a channel only once it connected; the public
 * URL only once it reached this server. Live tests run on POST /api/setup/check (and the provider
 * Test button); GET reads the cached results and never calls a model.
 * (Idea from CopilotKit OpenDuet's setup checks, MIT; re-implemented for z.)
 */
import { createHash } from "node:crypto";
import {
  codexAccount,
  describeError,
  english,
  laneRefs,
  parseModelRef,
  say,
  testModel,
  type CodexAccount,
  type Lane,
  type ModelCheck,
  type ModelRef,
  type ProviderConfig,
  type ServerText,
  type SetupChecklist,
  type SetupRow,
  type SetupState,
} from "@z/core";
import pkg from "../package.json" with { type: "json" };
import type { Channels } from "./channels.ts";
import type { Connectors } from "./connectors.ts";
import { accessTokenFile, isLoopback } from "./env.ts";
import type { Push } from "./push.ts";
import type { Runtime } from "./runtime.ts";
import { redactJson } from "./secrets.ts";

/** Live model tests are short: a free tier that takes longer than this is "not checked", not broken. */
const MODEL_TIMEOUT_MS = 15_000;
const PROBE_TIMEOUT_MS = 8_000;
/** A check makes at most this many model calls (quota on free tiers is shared and scarce). */
const MAX_MODEL_CALLS = 6;

const CHECKS_KEY = "setup.models";
const CHECKED_AT_KEY = "setup.checkedAt";
const MASTER_ACK_KEY = "setup.masterKeyBackedUp";
/** Per codex-cli provider: who the Codex CLI was signed in as when last checked, or why it couldn't say. */
const CODEX_KEY = "setup.codex";

type CodexCheck = { account?: CodexAccount; error?: string; at: string };

const LANE_NAMES = { agent: "laneAgent", briefing: "laneBriefing", fast: "laneFast", bot: "laneBot" } as const satisfies Record<Exclude<Lane, "chat">, string>;

type Probe = { ok: boolean; detail: ServerText; at: string };
type LaneResult = { state: SetupState; detail: ServerText };

/** Server-worded text (a key the app translates) or text z did not write (a provider's error). */
type Text = string | ServerText;
/** A row as built: label, detail and buttons as keys where z words them; `toRow` adds the English. */
type RowDraft = Omit<SetupRow, "label" | "detail" | "fix" | "ack" | "labelMsg" | "detailMsg" | "ackMsg"> & {
  label: Text;
  detail: Text;
  fix: { label: Text; path: string } | null;
  ack?: Text;
};

const msgOf = (text: Text) => (typeof text === "string" ? undefined : text);

/** English for API clients, plus the keys for the app (`labelMsg`, `detailMsg`, `fix.labelMsg`, `ackMsg`). */
function toRow({ label, detail, fix, ack, ...rest }: RowDraft): SetupRow {
  const labelMsg = msgOf(label);
  const detailMsg = msgOf(detail);
  const ackMsg = ack === undefined ? undefined : msgOf(ack);
  const fixMsg = fix ? msgOf(fix.label) : undefined;
  return {
    ...rest,
    label: english(label),
    detail: english(detail),
    fix: fix ? { label: english(fix.label), path: fix.path, ...(fixMsg ? { labelMsg: fixMsg } : {}) } : null,
    ...(ack === undefined ? {} : { ack: english(ack) }),
    ...(labelMsg ? { labelMsg } : {}),
    ...(detailMsg ? { detailMsg } : {}),
    ...(ackMsg ? { ackMsg } : {}),
  };
}

export type Setup = ReturnType<typeof createSetup>;

export function createSetup(rt: Runtime, channels: Channels, connectors: Connectors, push: Push) {
  const { store, env } = rt;
  let probe: Probe | null = null;
  let running: Promise<SetupChecklist> | null = null;

  const checks = (): Record<ModelRef, ModelCheck> => store.kv.get<Record<ModelRef, ModelCheck>>(CHECKS_KEY) ?? {};
  const saveCheck = (ref: ModelRef, check: ModelCheck) => store.kv.set(CHECKS_KEY, { ...checks(), [ref]: check });
  const codexChecks = (): Record<string, CodexCheck> => store.kv.get<Record<string, CodexCheck>>(CODEX_KEY) ?? {};
  const saveCodex = (providerId: string, check: Omit<CodexCheck, "at">) =>
    store.kv.set(CODEX_KEY, { ...codexChecks(), [providerId]: { ...check, at: new Date().toISOString() } });

  /** Why a ref can't be tried at all (no call needed), or null. */
  function unusable(ref: ModelRef, providers: ProviderConfig[]): ServerText | null {
    const p = providers.find((x) => x.id === parseModelRef(ref).providerId);
    if (!p) return say("providerRemoved", { provider: parseModelRef(ref).providerId });
    if (!p.enabled) return say("providerOff", { provider: p.label });
    return null;
  }

  const masterFingerprint = () => createHash("sha256").update(env.masterKey).digest("hex").slice(0, 16);

  /** A public URL off this machine means something (a tunnel, a proxy) forwards the world to z. */
  const publicRemote = () => {
    const publicHost = env.publicUrl ? safeHost(env.publicUrl) : null;
    return publicHost !== null && !isLoopback(publicHost.replace(/^\[|\]$/g, ""));
  };

  /** One lane's chain against the cached tests: any answering model makes it ready. */
  function laneResult(refs: ModelRef[], cache: Record<ModelRef, ModelCheck>, providers: ProviderConfig[]): LaneResult & { model?: ModelRef } {
    if (!refs.length) return { state: "needs_setup", detail: say("laneNoModel") };
    const failed: ServerText[] = [];
    let inconclusive: ServerText | null = null;
    for (const ref of refs) {
      const blocked = unusable(ref, providers);
      if (blocked) {
        failed.push(say("refIssue", { ref, issue: blocked }));
        continue;
      }
      const c = cache[ref];
      if (!c) {
        inconclusive ??= say("refNotChecked", { ref });
        continue;
      }
      if (c.ok) {
        const detail = say("refAnswered", {
          ref,
          ...(c.latencyMs !== undefined ? { seconds: c.latencyMs / 1000 } : {}),
          ...(failed.length ? { skipped: failed } : {}),
        });
        return { state: "ready", detail, model: ref };
      }
      if (c.rateLimited || c.timedOut) inconclusive ??= say(c.rateLimited ? "refRateLimited" : "refNoAnswer", { ref, ...(c.error ? { error: c.error } : {}) });
      else failed.push(say("refIssue", { ref, issue: c.error ? c.error.replace(/\.\s*$/, "") : say("failed") }));
    }
    if (inconclusive) return { state: "not_checked", detail: failed.length ? say("list", { items: [inconclusive, ...failed] }) : inconclusive };
    return { state: "needs_setup", detail: failed.length === 1 ? failed[0]! : say("list", { items: failed }) };
  }

  function rows(): SetupRow[] {
    const providers = store.providers.list();
    const routing = store.routing.get();
    const settings = store.settings.get();
    const cache = checks();
    const enabledChannels = store.channels.list().filter((c) => c.enabled);
    const enabledConnectors = connectors.list().filter((c) => c.enabled);
    const out: RowDraft[] = [];

    // ─── A chat model answers ───
    const models = { label: say("fixOpenModels"), path: "/models" };
    const chatLabel = say("rowChatModel");
    if (!providers.length) {
      out.push({ id: "chat_model", label: chatLabel, state: "needs_setup", detail: say("setupNoProvider"), fix: { label: say("fixAddProvider"), path: "/models" } });
    } else if (!routing.chat?.length) {
      out.push({ id: "chat_model", label: chatLabel, state: "needs_setup", detail: say("setupNoChatModel"), fix: { label: say("fixChooseChatModel"), path: "/models" } });
    } else {
      const chat = laneResult(routing.chat, cache, providers);
      const detail = chat.state === "not_checked" && english(chat.detail).endsWith("not checked yet") ? say("setupCheckChat", { detail: chat.detail }) : chat.detail;
      out.push({ id: "chat_model", label: chatLabel, state: chat.state, detail, fix: chat.state === "ready" ? null : models });
    }

    // ─── Codex CLI signed in (codex-cli providers) ───
    const codex = codexChecks();
    for (const p of providers.filter((x) => x.kind === "codex-cli" && x.enabled)) {
      const row = { id: `codex:${p.id}`, label: say("rowCodex", { provider: p.label }) };
      const c = codex[p.id];
      const a = c?.account;
      if (!c) out.push({ ...row, state: "not_checked", detail: say("codexNotChecked"), fix: null });
      else if (c.error) out.push({ ...row, state: "needs_setup", detail: c.error, fix: models });
      else if (!a?.signedIn) out.push({ ...row, state: "needs_setup", detail: say("codexSignedOut"), fix: null });
      else if (a.method === "chatgpt")
        out.push({ ...row, state: "ready", detail: say("codexChatgpt", { ...(a.plan ? { plan: a.plan } : {}), ...(a.email ? { email: a.email } : {}) }), fix: null });
      else out.push({ ...row, state: "ready", detail: say(a.method === "apiKey" ? "codexApiKey" : "codexOther"), fix: null });
    }

    // ─── Every job has a working model ───
    const lanes: Exclude<Lane, "chat">[] = ["agent", "briefing", "fast", ...(enabledChannels.length ? (["bot"] as const) : [])];
    const results = lanes.map((lane) => ({ lane, ...laneResult(laneRefs(routing, lane), cache, providers) }));
    const worst: SetupState = results.some((r) => r.state === "needs_setup") ? "needs_setup" : results.some((r) => r.state === "not_checked") ? "not_checked" : "ready";
    out.push({
      id: "lanes",
      label: say("rowLanes"),
      state: providers.length ? worst : "needs_setup",
      detail:
        worst === "ready"
          ? say("lanesReady", { lanes: results.map((r) => say(LANE_NAMES[r.lane])), models: [...new Set(results.map((r) => r.model!))] })
          : say("listDot", { items: results.filter((r) => r.state !== "ready").map((r) => say("laneIssue", { lane: say(LANE_NAMES[r.lane]), detail: r.detail })) }),
      fix: worst === "ready" ? null : models,
    });

    // ─── Access token when reachable beyond this computer ───
    const security = { label: say("fixOpenSecurity"), path: "/?settings=security" };
    const where = `${env.host}:${env.port}`;
    const label = say("rowToken");
    if (env.tokenSource === "env" && env.token) {
      out.push(
        env.token.length < 16
          ? { id: "token", label, state: "needs_setup", detail: say("tokenShort", { length: env.token.length }), fix: null }
          : { id: "token", label, state: "ready", detail: say("tokenEnv", { where }), fix: null },
      );
    } else if (env.tokenSource === "generated") {
      out.push({ id: "token", label, state: "ready", detail: say("tokenGenerated", { where, file: accessTokenFile(env.dataDir) }), fix: security });
    } else if (!publicRemote()) {
      out.push({ id: "token", label, state: "ready", detail: say("tokenLocalOnly", { host: env.host }), fix: null });
    } else {
      // Loopback behind a tunnel or reverse proxy: the public address reaches z with no token at all.
      out.push({ id: "token", label, state: "needs_setup", detail: say("tokenExposed", { where, origin: origin(env.publicUrl!) }), fix: security });
    }

    // ─── Public URL for webhook channels and OAuth ───
    const needers = [
      ...enabledChannels.filter((c) => channels.needsPublicUrl(c.kind)).map((c) => c.label),
      ...enabledConnectors.filter((c) => c.auth === "oauth").map((c) => c.label),
    ];
    const publicLabel = say("rowPublicUrl");
    if (env.publicUrl) {
      const host = safeHost(env.publicUrl);
      const at = origin(env.publicUrl);
      if (!host || (!env.publicUrl.startsWith("https://") && !isLoopback(host.replace(/^\[|\]$/g, "")))) {
        out.push({ id: "public_url", label: publicLabel, state: "needs_setup", detail: say("publicNotHttps", { origin: at }), fix: null });
      } else if (!probe) {
        out.push({ id: "public_url", label: publicLabel, state: "not_checked", detail: say("publicNotChecked", { origin: at }), fix: null });
      } else {
        out.push({ id: "public_url", label: publicLabel, state: probe.ok ? "ready" : "needs_setup", detail: probe.detail, fix: null });
      }
    } else if (needers.length) {
      out.push({ id: "public_url", label: publicLabel, state: "needs_setup", detail: say("publicNeeded", { names: needers }), fix: null });
    } else {
      out.push({ id: "public_url", label: publicLabel, state: "optional", detail: say("publicOptional"), fix: null });
    }

    // ─── Master key backed up ───
    const masterLabel = say("rowMasterKey");
    if (env.masterKeySource === "env") {
      out.push({ id: "master_key", label: masterLabel, state: "ready", detail: say("masterEnv"), fix: null });
    } else {
      const ack = store.kv.get<{ fingerprint: string; at: string }>(MASTER_ACK_KEY);
      out.push(
        ack?.fingerprint === masterFingerprint()
          ? { id: "master_key", label: masterLabel, state: "ready", detail: say("masterAcked", { date: ack.at.slice(0, 10) }), fix: null }
          : { id: "master_key", label: masterLabel, state: "needs_setup", detail: say("masterGenerated"), fix: null, ack: say("ackBackedUp") },
      );
    }

    // ─── Notifications on a device ───
    const devices = store.push.list().length;
    const notifications = { label: say("fixTurnOnNotifications"), path: "/?settings=notifications" };
    const pushLabel = say("rowPush");
    const last = push.lastSend();
    if (devices) {
      const failed = last && last.devices > 0 && last.sent === 0;
      out.push({
        id: "push",
        label: pushLabel,
        state: failed ? "needs_setup" : "ready",
        detail: failed
          ? say("pushNoneReached", { devices: last.devices })
          : say("pushDevices", { devices, ...(last ? { sent: last.sent, total: last.devices } : {}) }),
        fix: failed ? notifications : null,
      });
    } else if (settings.owner) {
      out.push({ id: "push", label: pushLabel, state: "optional", detail: say("pushViaOwner", { channel: settings.owner.label }), fix: notifications });
    } else {
      out.push({ id: "push", label: pushLabel, state: "needs_setup", detail: say("pushNone"), fix: notifications });
    }

    // ─── Owner paired ───
    const reach = { label: say("fixPair"), path: "/?settings=reach" };
    const ownerLabel = say("rowOwner");
    if (settings.owner) {
      const channel = store.channels.get(settings.owner.channelId);
      out.push(
        channel?.enabled
          ? { id: "owner", label: ownerLabel, state: "ready", detail: say("ownerReady", { name: settings.owner.label, channel: channel.label }), fix: null }
          : { id: "owner", label: ownerLabel, state: "needs_setup", detail: say("ownerGone", { channel: settings.owner.channelId }), fix: reach },
      );
    } else if (enabledChannels.length) {
      out.push({ id: "owner", label: ownerLabel, state: "needs_setup", detail: say("ownerPair", { channel: enabledChannels[0]!.label }), fix: reach });
    } else {
      out.push({ id: "owner", label: ownerLabel, state: "optional", detail: say("ownerOptional"), fix: { label: say("fixAddChannel"), path: "/channels" } });
    }

    // ─── Each enabled channel and connector ───
    // Their own status text when z wrote it (a key), else what the adapter or server said, else a fallback.
    const status = (c: { statusDetail: string | null; statusDetailMsg?: ServerText | null }, fallback: ServerText): Text =>
      c.statusDetailMsg ?? c.statusDetail ?? fallback;
    for (const c of enabledChannels) {
      const fix = { label: say("fixOpenChannels"), path: "/channels" };
      const row = { id: `channel:${c.id}`, label: `${c.label} (${c.kind})` };
      if (channels.needsPublicUrl(c.kind) && !env.publicUrl) out.push({ ...row, state: "needs_setup", detail: say("channelNeedsPublicUrl", { kind: c.kind, id: c.id }), fix });
      else if (c.status === "ok") out.push({ ...row, state: "ready", detail: status(c, say("chConnected")), fix: null });
      else if (c.status === "idle") out.push({ ...row, state: "not_checked", detail: status(c, say("channelNotConnectedYet")), fix });
      else out.push({ ...row, state: "needs_setup", detail: status(c, say("channelNotWorking")), fix });
    }
    for (const c of enabledConnectors) {
      const fix = { label: say("fixOpenConnection"), path: `/connect?connector=${encodeURIComponent(c.id)}` };
      const row = { id: `connector:${c.id}`, label: c.label };
      if (c.status === "connected") out.push({ ...row, state: "ready", detail: say("connectorTools", { count: c.tools.length, origin: c.urlDisplay }), fix: null });
      else if (c.status === "connecting") out.push({ ...row, state: "not_checked", detail: say("connectorConnecting"), fix: null });
      else out.push({ ...row, state: "needs_setup", detail: status(c, say(c.status === "needs_auth" ? "cnSignIn" : "connectorNotConnected")), fix });
    }
    return out.map(toRow);
  }

  // Provider errors can echo what was sent (some quote the key back): rows pass the secret registry too.
  const checklist = (): SetupChecklist => redactJson({ rows: rows(), checkedAt: store.kv.get<string>(CHECKED_AT_KEY) ?? null });

  /** Test each lane's chain in order until one model answers; one call per model per check. */
  async function checkModels() {
    const providers = store.providers.list();
    const routing = store.routing.get();
    const tested = new Map<ModelRef, ModelCheck>();
    let calls = 0;
    const lanes: Lane[] = ["chat", "agent", "briefing", "fast", "bot"];
    for (const lane of lanes) {
      for (const ref of laneRefs(routing, lane)) {
        let check = tested.get(ref);
        if (!check) {
          if (unusable(ref, providers) || calls >= MAX_MODEL_CALLS) continue;
          const { providerId, modelId } = parseModelRef(ref);
          calls++;
          const result = await testModel(providers.find((p) => p.id === providerId)!, modelId, MODEL_TIMEOUT_MS);
          check = toCheck(result);
          // A 429 or a slow free tier says nothing new: an earlier answer still stands.
          const previous = checks()[ref];
          if (!check.ok && (check.rateLimited || check.timedOut) && previous?.ok) check = previous;
          else saveCheck(ref, check);
          tested.set(ref, check);
        }
        if (check.ok) break;
      }
    }
  }

  async function probePublicUrl() {
    if (!env.publicUrl) return;
    const url = `${env.publicUrl}/api/health`;
    const at = new Date().toISOString();
    try {
      const res = await fetch(url, {
        headers: env.token ? { authorization: `Bearer ${env.token}` } : {},
        redirect: "manual",
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; version?: string } | null;
      const at0 = origin(env.publicUrl);
      if (res.ok && body?.ok && body.version === pkg.version) probe = { ok: true, detail: say("probeOk", { origin: at0 }), at };
      else if (res.ok && body?.ok) probe = { ok: false, detail: say("probeElsewhere", { origin: at0, theirs: String(body.version), ours: pkg.version }), at };
      else probe = { ok: false, detail: say("probeStatus", { origin: at0, status: res.status }), at };
    } catch (error) {
      probe = { ok: false, detail: say("probeUnreachable", { origin: origin(env.publicUrl), error: describeError(error) }), at };
    }
  }

  /** Start each enabled Codex CLI and read its sign-in (no model call). */
  async function checkCodex() {
    const bounded = <T,>(p: Promise<T>) =>
      Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("the Codex CLI did not answer in time")), PROBE_TIMEOUT_MS))]);
    await Promise.all(
      store.providers
        .list()
        .filter((p) => p.kind === "codex-cli" && p.enabled)
        .map(async (p) => {
          try {
            saveCodex(p.id, { account: await bounded(codexAccount(p)) });
          } catch (error) {
            saveCodex(p.id, { error: describeError(error) });
          }
        }),
    );
  }

  /** Reconnect what is failing, bounded so one slow server doesn't hold the check. */
  async function retryFailing() {
    const bounded = (p: Promise<unknown>) => Promise.race([p.catch(() => {}), new Promise((r) => setTimeout(r, PROBE_TIMEOUT_MS))]);
    await Promise.all([
      ...store.channels.list().filter((c) => c.enabled && c.status === "error").map((c) => bounded(channels.sync(c.id))),
      ...connectors.list().filter((c) => c.enabled && c.status === "error").map((c) => bounded(connectors.sync(c.id))),
    ]);
  }

  return {
    checklist,

    /** POST /api/setup/check: the live tests. Concurrent calls share one run. */
    check(): Promise<SetupChecklist> {
      running ??= (async () => {
        try {
          // Sign-in first: a signed-out Codex fails its model test with the same message.
          await checkCodex();
          await Promise.all([checkModels(), probePublicUrl(), retryFailing()]);
          store.kv.set(CHECKED_AT_KEY, new Date().toISOString());
          return checklist();
        } finally {
          running = null;
        }
      })();
      return running;
    },

    /** Rows the owner confirms themselves. Returns false for rows that can't be acknowledged. */
    ack(id: string): boolean {
      if (id !== "master_key" || env.masterKeySource !== "file") return false;
      store.kv.set(MASTER_ACK_KEY, { fingerprint: masterFingerprint(), at: new Date().toISOString() });
      return true;
    },

    /** The provider Test button counts as a live check of that model. */
    record(providerId: string, result: { ok: boolean; model?: string; error?: string; rateLimited?: boolean; timedOut?: boolean; latencyMs?: number; account?: CodexAccount }) {
      if (result.model) saveCheck(`${providerId}:${result.model}`, toCheck(result));
      if (store.providers.get(providerId)?.kind === "codex-cli") saveCodex(providerId, result.account ? { account: result.account } : { error: result.error ?? "failed" });
    },

    /** A provider's config changed (or it was removed): its earlier results no longer say anything. */
    forget(providerId: string) {
      const kept = Object.fromEntries(Object.entries(checks()).filter(([ref]) => parseModelRef(ref).providerId !== providerId));
      store.kv.set(CHECKS_KEY, kept);
      store.kv.set(CODEX_KEY, Object.fromEntries(Object.entries(codexChecks()).filter(([id]) => id !== providerId)));
    },

    modelChecks: checks,
  };
}

function toCheck(result: { ok: boolean; error?: string; rateLimited?: boolean; timedOut?: boolean; latencyMs?: number }): ModelCheck {
  return {
    ok: result.ok,
    ...(result.error ? { error: result.error } : {}),
    ...(result.rateLimited ? { rateLimited: true } : {}),
    ...(result.timedOut ? { timedOut: true } : {}),
    ...(result.latencyMs !== undefined ? { latencyMs: result.latencyMs } : {}),
    at: new Date().toISOString(),
  };
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** Never more than the origin: some setups put a secret in the path. */
export function origin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "(invalid URL)";
  }
}
