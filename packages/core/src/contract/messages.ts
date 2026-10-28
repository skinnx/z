import type { TaskStatus } from "./tasks.ts";

// ─── Server text: message keys + params, worded by the client ───────────────
// Text the server writes itself (setup rows, notices, channel and connector status, task and
// briefing phrases, route errors) travels as plain English *and*, next to it, an optional
// `ServerText` `{ key, params }` (fields named `…Msg`). The web app words the key in the owner's
// language; API clients can keep reading the English. Plugin/adapter text and model output stay as
// they are and get no key.
//
// `serverEn` is the single English source: the server renders the fallback text from it, and the
// web's `i18n/server.ts` must give every key a translation (a missing one is a type error).
// A param that is itself a `ServerText` (or a list of them) is worded first, then passed in as text.
// This file imports types only, so the web may load it (`@z/core/messages`) without the rest of core.

const s = (n: number) => (n === 1 ? "" : "s");

export const serverEn = {
  // ─── Generic joins ───
  list: (p: { items: string[] }) => p.items.join("; "),
  listDot: (p: { items: string[] }) => p.items.join(" · "),
  listComma: (p: { items: string[] }) => p.items.join(", "),
  failed: "failed",
  unknown: "unknown",

  // ─── Setup checklist: row labels ───
  rowChatModel: "A chat model answers",
  rowCodex: (p: { provider: string }) => `Codex CLI signed in (${p.provider})`,
  rowLanes: "Every job has a working model",
  rowToken: "Access token",
  rowPublicUrl: "Public URL (Z_PUBLIC_URL)",
  rowMasterKey: "Master key backed up",
  rowPush: "Notifications on a device",
  rowOwner: "Owner paired",

  // ─── Setup checklist: fix buttons ───
  fixOpenModels: "Open models",
  fixAddProvider: "Add a provider",
  fixChooseChatModel: "Choose a chat model",
  fixOpenSecurity: "Open security",
  fixTurnOnNotifications: "Turn on notifications",
  fixPair: "Pair",
  fixAddChannel: "Add a channel",
  fixOpenChannels: "Open channels",
  fixOpenConnection: "Open connection",
  ackBackedUp: "I backed it up",

  // ─── Setup checklist: models ───
  setupNoProvider: "No model provider yet. Free ones (Pollinations, LLM7) need no key.",
  setupNoChatModel: "No model is chosen for chat.",
  setupCheckChat: (p: { detail: string }) => `${p.detail}. Check again to send it a test message.`,
  laneNoModel: "no model chosen",
  laneAgent: "Tasks",
  laneBriefing: "Briefing",
  laneFast: "Quick checks",
  laneBot: "Channel bot",
  laneIssue: (p: { lane: string; detail: string }) => `${p.lane}: ${p.detail}`,
  lanesReady: (p: { lanes: string[]; models: string[] }) => `${p.lanes.join(", ")}: ${p.models.join(", ")}`,
  providerRemoved: (p: { provider: string }) => `provider "${p.provider}" was removed`,
  providerOff: (p: { provider: string }) => `provider "${p.provider}" is turned off`,
  refIssue: (p: { ref: string; issue: string }) => `${p.ref}: ${p.issue}`,
  refNotChecked: (p: { ref: string }) => `${p.ref} not checked yet`,
  refAnswered: (p: { ref: string; seconds?: number; skipped?: string[] }) =>
    `${p.ref} answered${p.seconds !== undefined ? ` in ${p.seconds.toFixed(1)} s` : ""}${p.skipped?.length ? ` (${p.skipped.join("; ")}; falls back)` : ""}`,
  refRateLimited: (p: { ref: string; error?: string }) => `${p.ref}: rate limited, so it could not be checked (${p.error ?? "try again"})`,
  refNoAnswer: (p: { ref: string; error?: string }) => `${p.ref}: no answer, so it could not be checked (${p.error ?? "try again"})`,

  // ─── Setup checklist: Codex CLI ───
  codexNotChecked: "Check again to start the Codex CLI on this machine and read its sign-in.",
  codexSignedOut: "Codex CLI is not signed in — run `codex login` on this server's machine, as the user z runs as.",
  codexChatgpt: (p: { plan?: string; email?: string }) => `Signed in with ChatGPT${p.plan ? ` (${p.plan} plan)` : ""}${p.email ? ` as ${p.email}` : ""}.`,
  codexApiKey: "Signed in with an OpenAI API key, not a ChatGPT plan.",
  codexOther: "Signed in to a non-OpenAI model provider.",

  // ─── Setup checklist: access token ───
  tokenShort: (p: { length: number }) => `Z_TOKEN is only ${p.length} characters. Use 32 or more random ones (openssl rand -hex 32).`,
  tokenEnv: (p: { where: string }) => `Z_TOKEN is set: every API request to ${p.where} must carry it.`,
  tokenGenerated: (p: { where: string; file: string }) =>
    `z listens on ${p.where}, beyond this computer, so it generated a token in ${p.file}. Enter it in the web app, or set Z_TOKEN to choose your own.`,
  tokenLocalOnly: (p: { host: string }) => `Only this computer can reach z (Z_HOST=${p.host}), so no token is needed.`,
  tokenExposed: (p: { where: string; origin: string }) =>
    `z listens on ${p.where} only, but ${p.origin} forwards to it without a token: anyone can spend your provider keys. Set Z_TOKEN (openssl rand -hex 32).`,

  // ─── Setup checklist: public URL ───
  publicNotHttps: (p: { origin: string }) => `${p.origin} is not https; platforms and OAuth providers only call https addresses.`,
  publicNotChecked: (p: { origin: string }) => `${p.origin}. Check again to test that it reaches this server.`,
  publicNeeded: (p: { names: string[] }) => `${p.names.join(", ")} must call z back. Set Z_PUBLIC_URL to the https address z is reachable at.`,
  publicOptional: "Only needed for webhook channels and OAuth sign-ins.",
  probeOk: (p: { origin: string }) => `${p.origin} reaches this server.`,
  probeElsewhere: (p: { origin: string; theirs: string; ours: string }) => `${p.origin} answers as z ${p.theirs}, but this server is ${p.ours}: it points elsewhere.`,
  probeStatus: (p: { origin: string; status: number }) =>
    `${p.origin}/api/health answered ${p.status}${p.status === 401 ? " (a different Z_TOKEN?)" : ""}; it does not reach this server.`,
  probeUnreachable: (p: { origin: string; error: string }) => `${p.origin} could not be reached: ${p.error}`,

  // ─── Setup checklist: master key, notifications, owner ───
  masterEnv: "Set by Z_MASTER_KEY. Keep that value in your password manager.",
  masterAcked: (p: { date: string }) => `You marked master.key as backed up on ${p.date}.`,
  masterGenerated: "z generated master.key in its data directory. Copy it somewhere safe: without it, stored keys and tokens can't be decrypted.",
  pushNoneReached: (p: { devices: number }) => `The last notification reached none of your ${p.devices} device${s(p.devices)}. Send a test from Notifications.`,
  pushDevices: (p: { devices: number; sent?: number; total?: number }) =>
    `${p.devices} device${s(p.devices)}${p.sent !== undefined && p.total !== undefined ? `; the last notification reached ${p.sent} of ${p.total}` : ""}.`,
  pushViaOwner: (p: { channel: string }) => `z reaches you in ${p.channel}; a device adds approvals on your lock screen.`,
  pushNone: "Nothing reaches you while the app is closed: approvals and watch hits wait unseen.",
  ownerReady: (p: { name: string; channel: string }) => `z reaches you as ${p.name} in ${p.channel}.`,
  ownerGone: (p: { channel: string }) => `The paired channel (${p.channel}) is gone or turned off.`,
  ownerPair: (p: { channel: string }) => `Pair yourself so approvals and briefings reach you in ${p.channel}.`,
  ownerOptional: "Connect a channel (Telegram, Discord, Slack…) to be reached away from the app.",

  // ─── Setup checklist: channels & connectors ───
  channelNeedsPublicUrl: (p: { kind: string; id: string }) => `Needs Z_PUBLIC_URL: ${p.kind} calls z at /hooks/${p.id}.`,
  channelNotConnectedYet: "Not connected yet",
  channelNotWorking: "Not working",
  connectorTools: (p: { count: number; origin: string }) => `${p.count} tool${s(p.count)} from ${p.origin}`,
  connectorConnecting: "Connecting…",
  connectorNotConnected: "Not connected",

  // ─── Channel status (ChannelView.statusDetailMsg) ───
  chDisabled: "Disabled",
  chConnected: "Connected",
  chNoAdapter: (p: { kind: string }) => `No enabled plugin provides a "${p.kind}" adapter`,
  chNeedsPublicUrl: "Set Z_PUBLIC_URL so the platform can reach /hooks",
  chWaitingWebhook: "Waiting for the first webhook",
  chCouldNotConnect: (p: { error: string }) => `Could not connect: ${p.error}`,
  chBotFailed: (p: { error: string }) => `Bot failed: ${p.error}`,
  chOwnerUnreachable: (p: { error: string }) => `Could not reach the owner: ${p.error}`,
  chWebhookFailed: (p: { error: string }) => `Webhook failed: ${p.error}`,
  chOverLimit: (p: { minutes: number }) => `Over a limit: may try again in ${p.minutes} min`,
  chHookFailed: "Webhook handler failed",
  chTestWebhookOnly: "Only webhook channels can be tested this way",
  chTestNoSecret: "The channel has no signing secret",

  // ─── Connector status (ConnectorView.statusDetailMsg) ───
  cnWaitingSignIn: "Waiting for sign-in",
  cnSignIn: "Sign in to connect",
  cnSignInAgain: "Sign in again to connect",
  cnRejected: "The server rejected the credentials (HTTP 401)",
  cnRejectedHeaders: "The server rejected the credentials (HTTP 401): check the header values",
  cnRequiresSignIn: "The server requires sign-in: use OAuth or add an authorization header",
  cnSignInCancelled: "Sign-in was cancelled",
  cnSignInFailed: (p: { error: string }) => `Sign-in failed: ${p.error}`,
  cnRetrying: (p: { detail: string; seconds: number }) => `${p.detail} · retrying in ${p.seconds}s`,

  // ─── Notices (Notice.titleMsg / bodyMsg) ───
  noticeApproval: (p: { title: string }) => `Approval needed · ${p.title}`,
  /** `action`: the tool's one-line summary; `details`: the preview's plain fields; `more`: set when some were left for the app. */
  noticeApprovalBody: (p: { reason?: string; action: string; details?: string; more?: string }) =>
    [p.reason ? `Asking because ${p.reason}` : "", p.action, p.details ?? "", p.more ?? ""].filter(Boolean).join("\n\n"),
  approvalUseTool: (p: { tool: string }) => `Use ${p.tool}`,
  approvalMore: "More details in z: open it to review them.",
  noticeQuestion: (p: { title: string }) => `Question · ${p.title}`,
  noticeQuestionBody: (p: { question: string; choices?: string[] }) => `${p.question}${p.choices?.length ? `\nChoices: ${p.choices.join(" / ")}` : ""}`,
  noticeDone: (p: { title: string }) => `Done · ${p.title}`,
  noticeReview: (p: { title: string }) => `Ready for review · ${p.title}`,
  noticeFailed: (p: { title: string }) => `Failed · ${p.title}`,
  noticeFailing: (p: { title: string }) => `Failing · ${p.title}`,
  noticePaused: (p: { title: string }) => `Paused · ${p.title}`,
  noticePausedBody: (p: { failures: number; error: string }) =>
    `Failed ${p.failures} runs in a row, so z stopped running it. Last error: ${p.error}. Run it again once fixed.`,
  noticeInterrupted: (p: { title: string }) => `Interrupted · ${p.title}`,
  /** Also Task.errorMsg of an interrupted task. */
  taskInterrupted: (p: { summary: string }) => `z stopped mid-action: ${p.summary}. Check and run again if needed.`,
  noticeBriefing: (p: { needsYou: number; proposals: number }) =>
    [
      "Your briefing",
      p.needsYou ? `${p.needsYou} need${p.needsYou === 1 ? "s" : ""} you` : "",
      p.proposals ? `${p.proposals} task${s(p.proposals)} worth delegating` : "",
    ]
      .filter(Boolean)
      .join(" · "),
  noticeMemory: (p: { handle: string; count: number }) => `${p.handle} wants to remember ${p.count === 1 ? "1 thing" : `${p.count} things`}`,
  noticeSaveLogin: (p: { host: string }) => `Save a sign-in for ${p.host}?`,
  noticeSaveLoginBody: (p: { origin: string }) => `z was asked to sign in to ${p.origin} but nothing is saved for it. Add it under Settings → Security → Saved sign-ins.`,

  // ─── Briefing (Briefing.summaryMsg, BriefItem.textMsg / reasonMsg) ───
  briefNothingNew: "Nothing new since your last briefing.",
  briefPlain: (p: { count: number; parts: string[] }) => `${p.count} item${s(p.count)} since your last briefing: ${p.parts.join(", ")}.`,
  briefFromSource: (p: { count: number; source: string }) => `${p.count} from ${p.source}`,
  briefTaskWaiting: (p: { title: string }) => `Waiting for your approval: ${p.title}`,
  briefTaskNeedsInput: (p: { title: string }) => `Waiting for your answer: ${p.title}`,
  briefTaskOpen: (p: { title: string; status: TaskStatus }) => `${p.title} (${p.status})`,
  briefNotChecked: "Not checked: no model sorted this item.",
  briefProposed: "Proposed by z; optional.",
  briefDelegated: "Already delegated; z is on it.",
  briefClosed: "Already closed or merged.",
  briefRead: "Already seen.",
  briefCiPassed: "The check passed; nothing to fix.",
  briefBot: "Routine upkeep opened by a bot.",
  briefPromotional: "A newsletter or promotion.",

  // ─── Route errors (`{ error, errorMsg }`) ───
  /** Validation and other request problems: the detail stays English, the client adds a translated prefix. */
  errInvalid: (p: { detail: string }) => p.detail,
  errNotFound: (p: { what: string }) => `${p.what} not found`,
  errRouteNotFound: "Not found",
  errBodyJson: "Body must be JSON",
  errInternal: "Internal server error",
  errUnauthorized: "Unauthorized",
  errConflict: (p: { detail: string }) => p.detail,
  errTaskBusy: (p: { status: TaskStatus }) => `Task is already ${p.status}`,
  errTaskNotAsking: (p: { status: TaskStatus }) => `Task is ${p.status}, not waiting for an answer`,
  errTaskNotReview: (p: { status: TaskStatus }) => `Task is ${p.status}, not ready for review`,
  errApprovalDecided: (p: { status: string }) => `Approval is already ${p.status}`,
  errLoginExists: (p: { origin: string }) => `A sign-in for ${p.origin} is already saved`,
  errSkillExists: (p: { name: string }) => `A skill named /${p.name} already exists`,
  errListModels: (p: { error: string }) => `Could not list models: ${p.error}`,
  errBriefing: (p: { error: string }) => `Briefing failed: ${p.error}`,
  errNoAck: "This item can't be confirmed by hand",
  errNotOAuth: "This connector does not use OAuth",
  errNoModel: "No model is configured for this lane. Add a provider and set routing.",
  thingChannel: "Channel",
  thingThread: "Thread",
  thingProvider: "Provider",
  thingPlugin: "Plugin",
  thingConnector: "Connector",
  thingLogin: "Sign-in",
  thingMemory: "Memory",
  thingSkill: "Skill",
  thingTask: "Task",
  thingApproval: "Approval",
} as const;

export type ServerTextKey = keyof typeof serverEn;

/** The params a key's English wording takes, already worded (nested ServerText become text). */
export type ServerTextParams<K extends ServerTextKey> = (typeof serverEn)[K] extends (p: infer A) => string ? A : never;

/** What the server sends for a param: text, or a ServerText the client words first. */
type Raw<T> = {
  [F in keyof T]: NonNullable<T[F]> extends string
    ? T[F] | ServerText
    : NonNullable<T[F]> extends readonly string[]
      ? (string | ServerText)[]
      : T[F];
};

export type ServerText = {
  [K in ServerTextKey]: [ServerTextParams<K>] extends [never] ? { key: K; params?: undefined } : { key: K; params: Raw<ServerTextParams<K>> };
}[ServerTextKey];

/** A dictionary for server text in one language: same keys and call signatures as `serverEn`. */
export type ServerDict = { [K in ServerTextKey]: (typeof serverEn)[K] extends (p: infer A) => string ? (p: A) => string : string };

/** Build a ServerText. `say("noticeDone", { title })`. */
export function say<K extends ServerTextKey>(key: K, ...params: [ServerTextParams<K>] extends [never] ? [] : [Raw<ServerTextParams<K>>]): ServerText {
  return (params.length ? { key, params: params[0] } : { key }) as ServerText;
}

type Entry = string | ((p: any) => string);

/**
 * Word a ServerText with `dict`, falling back to English per key; null for a key neither knows
 * (a newer server than this client), so the caller shows the English text it got.
 */
export function wordServerText(msg: ServerText, dict: Partial<Record<string, Entry>> = serverEn as Record<string, Entry>): string | null {
  const entry = (dict[msg.key] ?? (serverEn as Record<string, Entry>)[msg.key]) as Entry | undefined;
  if (entry === undefined) return null;
  if (typeof entry === "string") return entry;
  const word = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(word) : isServerText(v) ? (wordServerText(v, dict) ?? wordServerText(v) ?? v.key) : v;
  const params = Object.fromEntries(Object.entries((msg.params ?? {}) as Record<string, unknown>).map(([k, v]) => [k, word(v)]));
  try {
    return entry(params);
  } catch {
    return null;
  }
}

/** English for text that may be a ServerText. */
export function english(text: string | ServerText): string {
  return typeof text === "string" ? text : (wordServerText(text) ?? text.key);
}

export function isServerText(v: unknown): v is ServerText {
  return typeof v === "object" && v !== null && typeof (v as { key?: unknown }).key === "string" && !Array.isArray(v);
}

// ─── End server text ────────────────────────────────────────────────────────
