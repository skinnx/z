/**
 * The setup checklist: what z needs to be useful and safe, each row computed from a real check.
 * A model is ready only once it answered a live test; a channel only once it connected; the public
 * URL only once it reached this server. Live tests run on POST /api/setup/check (and the provider
 * Test button); GET reads the cached results and never calls a model.
 * (Idea from CopilotKit OpenDuet's setup checks, MIT; re-implemented for z.)
 */
import { createHash } from "node:crypto";
import { codexAccount, CODEX_NOT_SIGNED_IN, describeError, laneRefs, parseModelRef, testModel, type CodexAccount, type Lane, type ModelCheck, type ModelRef, type ProviderConfig, type SetupChecklist, type SetupRow, type SetupState } from "@z/core";
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

const LANE_NAMES: Record<Exclude<Lane, "chat">, string> = { agent: "Tasks", briefing: "Briefing", fast: "Quick checks", bot: "Channel bot" };

type Probe = { ok: boolean; detail: string; at: string };
type LaneResult = { state: SetupState; detail: string };

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
  function unusable(ref: ModelRef, providers: ProviderConfig[]): string | null {
    const p = providers.find((x) => x.id === parseModelRef(ref).providerId);
    if (!p) return `provider "${parseModelRef(ref).providerId}" was removed`;
    if (!p.enabled) return `provider "${p.label}" is turned off`;
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
    if (!refs.length) return { state: "needs_setup", detail: "no model chosen" };
    const failed: string[] = [];
    let inconclusive: string | null = null;
    for (const ref of refs) {
      const blocked = unusable(ref, providers);
      if (blocked) {
        failed.push(`${ref}: ${blocked}`);
        continue;
      }
      const c = cache[ref];
      if (!c) {
        inconclusive ??= `${ref} not checked yet`;
        continue;
      }
      if (c.ok) {
        const latency = c.latencyMs !== undefined ? ` in ${(c.latencyMs / 1000).toFixed(1)} s` : "";
        const fell = failed.length ? ` (${failed.join("; ")}; falls back)` : "";
        return { state: "ready", detail: `${ref} answered${latency}${fell}`, model: ref };
      }
      if (c.rateLimited || c.timedOut) inconclusive ??= `${ref}: ${c.rateLimited ? "rate limited" : "no answer"}, so it could not be checked (${c.error ?? "try again"})`;
      else failed.push(`${ref}: ${(c.error ?? "failed").replace(/\.\s*$/, "")}`);
    }
    if (inconclusive) return { state: "not_checked", detail: [inconclusive, ...failed].join("; ") };
    return { state: "needs_setup", detail: failed.join("; ") };
  }

  function rows(): SetupRow[] {
    const providers = store.providers.list();
    const routing = store.routing.get();
    const settings = store.settings.get();
    const cache = checks();
    const enabledChannels = store.channels.list().filter((c) => c.enabled);
    const enabledConnectors = connectors.list().filter((c) => c.enabled);
    const out: SetupRow[] = [];

    // ─── A chat model answers ───
    const models = { label: "Open models", path: "/models" };
    if (!providers.length) {
      out.push({ id: "chat_model", label: "A chat model answers", state: "needs_setup", detail: "No model provider yet. Free ones (Pollinations, LLM7) need no key.", fix: { label: "Add a provider", path: "/models" } });
    } else if (!routing.chat?.length) {
      out.push({ id: "chat_model", label: "A chat model answers", state: "needs_setup", detail: "No model is chosen for chat.", fix: { label: "Choose a chat model", path: "/models" } });
    } else {
      const chat = laneResult(routing.chat, cache, providers);
      const detail = chat.state === "not_checked" && chat.detail.endsWith("not checked yet") ? `${chat.detail}. Check again to send it a test message.` : chat.detail;
      out.push({ id: "chat_model", label: "A chat model answers", state: chat.state, detail, fix: chat.state === "ready" ? null : models });
    }

    // ─── Codex CLI signed in (codex-cli providers) ───
    const codex = codexChecks();
    for (const p of providers.filter((x) => x.kind === "codex-cli" && x.enabled)) {
      const row = { id: `codex:${p.id}`, label: `Codex CLI signed in (${p.label})` };
      const c = codex[p.id];
      const a = c?.account;
      if (!c) out.push({ ...row, state: "not_checked", detail: "Check again to start the Codex CLI on this machine and read its sign-in.", fix: null });
      else if (c.error) out.push({ ...row, state: "needs_setup", detail: c.error, fix: models });
      else if (!a?.signedIn) out.push({ ...row, state: "needs_setup", detail: `${CODEX_NOT_SIGNED_IN}, as the user z runs as.`, fix: null });
      else if (a.method === "chatgpt")
        out.push({ ...row, state: "ready", detail: `Signed in with ChatGPT${a.plan ? ` (${a.plan} plan)` : ""}${a.email ? ` as ${a.email}` : ""}.`, fix: null });
      else out.push({ ...row, state: "ready", detail: a.method === "apiKey" ? "Signed in with an OpenAI API key, not a ChatGPT plan." : "Signed in to a non-OpenAI model provider.", fix: null });
    }

    // ─── Every job has a working model ───
    const lanes: Exclude<Lane, "chat">[] = ["agent", "briefing", "fast", ...(enabledChannels.length ? (["bot"] as const) : [])];
    const results = lanes.map((lane) => ({ lane, ...laneResult(laneRefs(routing, lane), cache, providers) }));
    const worst: SetupState = results.some((r) => r.state === "needs_setup") ? "needs_setup" : results.some((r) => r.state === "not_checked") ? "not_checked" : "ready";
    out.push({
      id: "lanes",
      label: "Every job has a working model",
      state: providers.length ? worst : "needs_setup",
      detail:
        worst === "ready"
          ? `${results.map((r) => LANE_NAMES[r.lane]).join(", ")}: ${[...new Set(results.map((r) => r.model))].join(", ")}`
          : results.filter((r) => r.state !== "ready").map((r) => `${LANE_NAMES[r.lane]}: ${r.detail}`).join(" · "),
      fix: worst === "ready" ? null : models,
    });

    // ─── Access token when reachable beyond this computer ───
    const security = { label: "Open security", path: "/?settings=security" };
    const where = `${env.host}:${env.port}`;
    const label = "Access token";
    if (env.tokenSource === "env" && env.token) {
      out.push(
        env.token.length < 16
          ? { id: "token", label, state: "needs_setup", detail: `Z_TOKEN is only ${env.token.length} characters. Use 32 or more random ones (openssl rand -hex 32).`, fix: null }
          : { id: "token", label, state: "ready", detail: `Z_TOKEN is set: every API request to ${where} must carry it.`, fix: null },
      );
    } else if (env.tokenSource === "generated") {
      out.push({
        id: "token",
        label,
        state: "ready",
        detail: `z listens on ${where}, beyond this computer, so it generated a token in ${accessTokenFile(env.dataDir)}. Enter it in the web app, or set Z_TOKEN to choose your own.`,
        fix: security,
      });
    } else if (!publicRemote()) {
      out.push({ id: "token", label, state: "ready", detail: `Only this computer can reach z (Z_HOST=${env.host}), so no token is needed.`, fix: null });
    } else {
      // Loopback behind a tunnel or reverse proxy: the public address reaches z with no token at all.
      out.push({
        id: "token",
        label,
        state: "needs_setup",
        detail: `z listens on ${where} only, but ${origin(env.publicUrl!)} forwards to it without a token: anyone can spend your provider keys. Set Z_TOKEN (openssl rand -hex 32).`,
        fix: security,
      });
    }

    // ─── Public URL for webhook channels and OAuth ───
    const needers = [
      ...enabledChannels.filter((c) => channels.needsPublicUrl(c.kind)).map((c) => c.label),
      ...enabledConnectors.filter((c) => c.auth === "oauth").map((c) => c.label),
    ];
    if (env.publicUrl) {
      const host = safeHost(env.publicUrl);
      const at = origin(env.publicUrl);
      if (!host || (!env.publicUrl.startsWith("https://") && !isLoopback(host.replace(/^\[|\]$/g, "")))) {
        out.push({ id: "public_url", label: "Public URL (Z_PUBLIC_URL)", state: "needs_setup", detail: `${at} is not https; platforms and OAuth providers only call https addresses.`, fix: null });
      } else if (!probe) {
        out.push({ id: "public_url", label: "Public URL (Z_PUBLIC_URL)", state: "not_checked", detail: `${at}. Check again to test that it reaches this server.`, fix: null });
      } else {
        out.push({ id: "public_url", label: "Public URL (Z_PUBLIC_URL)", state: probe.ok ? "ready" : "needs_setup", detail: probe.detail, fix: null });
      }
    } else if (needers.length) {
      out.push({
        id: "public_url",
        label: "Public URL (Z_PUBLIC_URL)",
        state: "needs_setup",
        detail: `${needers.join(", ")} must call z back. Set Z_PUBLIC_URL to the https address z is reachable at.`,
        fix: null,
      });
    } else {
      out.push({ id: "public_url", label: "Public URL (Z_PUBLIC_URL)", state: "optional", detail: "Only needed for webhook channels and OAuth sign-ins.", fix: null });
    }

    // ─── Master key backed up ───
    if (env.masterKeySource === "env") {
      out.push({ id: "master_key", label: "Master key backed up", state: "ready", detail: "Set by Z_MASTER_KEY. Keep that value in your password manager.", fix: null });
    } else {
      const ack = store.kv.get<{ fingerprint: string; at: string }>(MASTER_ACK_KEY);
      out.push(
        ack?.fingerprint === masterFingerprint()
          ? { id: "master_key", label: "Master key backed up", state: "ready", detail: `You marked master.key as backed up on ${ack.at.slice(0, 10)}.`, fix: null }
          : {
              id: "master_key",
              label: "Master key backed up",
              state: "needs_setup",
              detail: "z generated master.key in its data directory. Copy it somewhere safe: without it, stored keys and tokens can't be decrypted.",
              fix: null,
              ack: "I backed it up",
            },
      );
    }

    // ─── Notifications on a device ───
    const devices = store.push.list().length;
    const notifications = { label: "Turn on notifications", path: "/?settings=notifications" };
    const last = push.lastSend();
    if (devices) {
      const failed = last && last.devices > 0 && last.sent === 0;
      out.push({
        id: "push",
        label: "Notifications on a device",
        state: failed ? "needs_setup" : "ready",
        detail: failed
          ? `The last notification reached none of your ${last.devices} device${last.devices === 1 ? "" : "s"}. Send a test from Notifications.`
          : `${devices} device${devices === 1 ? "" : "s"}${last ? `; the last notification reached ${last.sent} of ${last.devices}` : ""}.`,
        fix: failed ? notifications : null,
      });
    } else if (settings.owner) {
      out.push({ id: "push", label: "Notifications on a device", state: "optional", detail: `z reaches you in ${settings.owner.label}; a device adds approvals on your lock screen.`, fix: notifications });
    } else {
      out.push({ id: "push", label: "Notifications on a device", state: "needs_setup", detail: "Nothing reaches you while the app is closed: approvals and watch hits wait unseen.", fix: notifications });
    }

    // ─── Owner paired ───
    const reach = { label: "Pair", path: "/?settings=reach" };
    if (settings.owner) {
      const channel = store.channels.get(settings.owner.channelId);
      out.push(
        channel?.enabled
          ? { id: "owner", label: "Owner paired", state: "ready", detail: `z reaches you as ${settings.owner.label} in ${channel.label}.`, fix: null }
          : { id: "owner", label: "Owner paired", state: "needs_setup", detail: `The paired channel (${settings.owner.channelId}) is gone or turned off.`, fix: reach },
      );
    } else if (enabledChannels.length) {
      out.push({ id: "owner", label: "Owner paired", state: "needs_setup", detail: `Pair yourself so approvals and briefings reach you in ${enabledChannels[0]!.label}.`, fix: reach });
    } else {
      out.push({ id: "owner", label: "Owner paired", state: "optional", detail: "Connect a channel (Telegram, Discord, Slack…) to be reached away from the app.", fix: { label: "Add a channel", path: "/channels" } });
    }

    // ─── Each enabled channel and connector ───
    for (const c of enabledChannels) {
      const fix = { label: "Open channels", path: "/channels" };
      const row = { id: `channel:${c.id}`, label: `${c.label} (${c.kind})` };
      if (channels.needsPublicUrl(c.kind) && !env.publicUrl) out.push({ ...row, state: "needs_setup", detail: `Needs Z_PUBLIC_URL: ${c.kind} calls z at /hooks/${c.id}.`, fix });
      else if (c.status === "ok") out.push({ ...row, state: "ready", detail: c.statusDetail ?? "Connected", fix: null });
      else if (c.status === "idle") out.push({ ...row, state: "not_checked", detail: c.statusDetail ?? "Not connected yet", fix });
      else out.push({ ...row, state: "needs_setup", detail: c.statusDetail ?? "Not working", fix });
    }
    for (const c of enabledConnectors) {
      const fix = { label: "Open connection", path: `/connect?connector=${encodeURIComponent(c.id)}` };
      const row = { id: `connector:${c.id}`, label: c.label };
      if (c.status === "connected") out.push({ ...row, state: "ready", detail: `${c.tools.length} tool${c.tools.length === 1 ? "" : "s"} from ${c.urlDisplay}`, fix: null });
      else if (c.status === "connecting") out.push({ ...row, state: "not_checked", detail: "Connecting…", fix: null });
      else out.push({ ...row, state: "needs_setup", detail: c.statusDetail ?? (c.status === "needs_auth" ? "Sign in to connect" : "Not connected"), fix });
    }
    return out;
  }

  // Provider errors can echo what was sent (some quote the key back): rows pass the secret registry too.
  const checklist = (): SetupChecklist =>
    redactJson({
      rows: rows(),
      checkedAt: store.kv.get<string>(CHECKED_AT_KEY) ?? null,
      modelAnswered: Object.values(checks()).some((c) => c.ok) || store.usage.any(),
    });

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
      if (res.ok && body?.ok && body.version === pkg.version) probe = { ok: true, detail: `${origin(env.publicUrl)} reaches this server.`, at };
      else if (res.ok && body?.ok) probe = { ok: false, detail: `${origin(env.publicUrl)} answers as z ${body.version}, but this server is ${pkg.version}: it points elsewhere.`, at };
      else probe = { ok: false, detail: `${origin(env.publicUrl)}/api/health answered ${res.status}${res.status === 401 ? " (a different Z_TOKEN?)" : ""}; it does not reach this server.`, at };
    } catch (error) {
      probe = { ok: false, detail: `${origin(env.publicUrl)} could not be reached: ${describeError(error)}`, at };
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
