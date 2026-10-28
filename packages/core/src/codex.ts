/**
 * The `codex-cli` provider: z on the owner's ChatGPT plan through the official Codex CLI.
 *
 * z talks to `codex app-server` (JSON-RPC over stdio, OpenAI's surface for embedding Codex), which
 * owns sign-in: z never reads or forwards Codex credentials. Each model call is one Codex turn in an
 * ephemeral thread whose history z injects. z's tools are the thread's dynamic tools; when Codex calls
 * one, the model step ends with an ordinary tool call, so the AI SDK loop runs it through z's guard,
 * safety floor, policy, reviewer and approvals (a pause can last as long as an approval takes), and the
 * next step answers Codex with the result. Codex's own shell, file, MCP and web tools are turned off,
 * its sandbox is read-only in an empty directory, every approval it asks for is declined, and a built-in
 * tool that runs anyway stops the turn.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
  APICallError,
  type LanguageModelV4,
  type LanguageModelV4CallOptions,
  type LanguageModelV4Content,
  type LanguageModelV4FinishReason,
  type LanguageModelV4Message,
  type LanguageModelV4StreamPart,
  type LanguageModelV4ToolResultOutput,
  type LanguageModelV4Usage,
  type SharedV4Warning,
} from "@ai-sdk/provider";
import { CODEX_NOT_SIGNED_IN, type CodexAccount } from "./contract.ts";
import { ModelUnavailableError } from "./model-errors.ts";
import type { ProviderConfig } from "./providers.ts";

/** A Codex turn paused on a tool call (an approval, say) is given up after this; a later step replays the history. */
const PAUSE_MS = 30 * 60_000;
/** An app-server with no thread in use exits after this. */
const IDLE_MS = 5 * 60_000;
/** Tool calls Codex issues together arrive within this of each other; the step ends once it's quiet. */
const GATHER_MS = 40;
const REQUEST_TIMEOUT_MS = 30_000;

/** What Codex may never do on z's behalf: these are refused and the model is told so. */
const REFUSAL = "z runs Codex without its built-in tools; use the tools z offers instead.";

/**
 * Turn off everything that would let Codex act outside z's approvals, whatever the owner's
 * ~/.codex/config.toml enables. Unknown keys are ignored by older CLIs.
 */
const LOCKDOWN = [
  'web_search="disabled"',
  "mcp_servers={}",
  "project_doc_max_bytes=0",
  "include_apps_instructions=false",
  "include_permissions_instructions=false",
  "include_environment_context=false",
  "include_collaboration_mode_instructions=false",
  "skills.include_instructions=false",
  ...[
    "shell_tool",
    "unified_exec",
    "apps",
    "plugins",
    "multi_agent",
    "computer_use",
    "browser_use",
    "in_app_browser",
    "image_generation",
    "view_image",
    "hooks",
    "memories",
    "skill_search",
    "tool_suggest",
    "goals",
    "sleep_tool",
  ].map((f) => `features.${f}=false`),
].flatMap((c) => ["-c", c]);

/** Thread items that are conversation, not actions. Anything else that completes means Codex acted. */
const CONVERSATION_ITEMS = new Set(["userMessage", "hookPrompt", "agentMessage", "reasoning", "plan", "dynamicToolCall", "contextCompaction", "functionCallOutput"]);

export class CodexNotSignedInError extends ModelUnavailableError {
  override name = "CodexNotSignedInError";
  constructor() {
    super(CODEX_NOT_SIGNED_IN);
  }
}

// ─── Finding and running the CLI ────────────────────────────────────────────

export type CodexCommand = { file: string; args: string[] };

/** The configured binary, else `codex` on PATH, else the one shipped with z (@openai/codex). */
export function codexCommand(p: Pick<ProviderConfig, "command">): CodexCommand {
  if (p.command) return /\.[cm]?js$/.test(p.command) ? { file: process.execPath, args: [p.command] } : { file: p.command, args: [] };
  const names = process.platform === "win32" ? ["codex.exe", "codex.cmd"] : ["codex"];
  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const name of names) {
      try {
        accessSync(join(dir, name), constants.X_OK);
        return { file: join(dir, name), args: [] };
      } catch {}
    }
  }
  try {
    return { file: process.execPath, args: [fileURLToPath(import.meta.resolve("@openai/codex/bin/codex.js"))] };
  } catch {
    throw new ModelUnavailableError("Codex CLI not found: install it (npm i -g @openai/codex) or set the path to `codex`");
  }
}

/** z's own secrets (master key, access token, provider keys) never reach the Codex process. */
function childEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^Z_/.test(k) && !/API_?KEY|TOKEN|SECRET|PASSWORD/i.test(k)));
}

let workDir: string | null = null;
/** An empty directory: Codex's read-only sandbox has nothing of z's to look at there. */
const emptyDir = () => (workDir ??= mkdtempSync(join(tmpdir(), "z-codex-")));

type Json = any;
type RpcId = number | string;

/** What a thread hears from the app-server. */
type ThreadListener = {
  notification: (method: string, params: Json) => void;
  toolCall: (id: RpcId, params: Json) => void;
  refused: (method: string, params: Json) => void;
  exit: (error: Error) => void;
};

const servers = new Map<string, AppServer>();
let exitHook = false;

class AppServer {
  readonly cwd = emptyDir();
  private proc: ChildProcessWithoutNullStreams;
  private seq = 0;
  private calls = new Map<RpcId, { resolve: (v: Json) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private threads = new Map<string, ThreadListener>();
  private stderr: string[] = [];
  private idle: NodeJS.Timeout | null = null;
  private dead: Error | null = null;
  readonly ready: Promise<void>;

  private key: string;

  constructor(key: string, cmd: CodexCommand) {
    this.key = key;
    this.proc = spawn(cmd.file, [...cmd.args, "app-server", ...LOCKDOWN], { cwd: this.cwd, env: childEnv(), stdio: ["pipe", "pipe", "pipe"] });
    this.proc.on("error", (e) => this.die(new ModelUnavailableError(`Could not start the Codex CLI (${cmd.file}): ${e.message}`)));
    this.proc.on("exit", (code, signal) => {
      const tail = this.stderr.join("").trim().split("\n").slice(-3).join(" ").slice(0, 300);
      this.die(new ModelUnavailableError(`Codex app-server exited (${signal ?? code})${tail ? `: ${tail}` : ""}`));
    });
    this.proc.stderr.on("data", (d: Buffer) => {
      // Codex logs with ANSI colours; keep a short plain tail for error messages.
      this.stderr.push(String(d).replace(/\x1b\[[0-9;]*m/g, ""));
      if (this.stderr.length > 20) this.stderr.shift();
    });
    this.proc.stdin.on("error", () => {});
    createInterface({ input: this.proc.stdout }).on("line", (line) => this.receive(line));
    this.ready = this.request("initialize", {
      clientInfo: { name: "z", title: "z", version: "0.1.0" },
      // Dynamic tools and thread/inject_items are behind the experimental API.
      capabilities: { experimentalApi: true, requestAttestation: false },
    }).then(() => this.send({ method: "initialized" }));
    this.ready.catch(() => {});
    this.touch();
  }

  /** The shared app-server for a command, started on first use. */
  static async for(cmd: CodexCommand): Promise<AppServer> {
    const key = [cmd.file, ...cmd.args].join("\0");
    let server = servers.get(key);
    if (!server || server.dead) {
      server = new AppServer(key, cmd);
      servers.set(key, server);
      if (!exitHook) {
        exitHook = true;
        process.once("exit", () => closeCodexServers());
      }
    }
    await server.ready;
    return server;
  }

  request<T = Json>(method: string, params: Json, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    if (this.dead) return Promise.reject(this.dead);
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.calls.delete(id);
        reject(new ModelUnavailableError(`Codex app-server did not answer ${method} within ${timeoutMs / 1000} s`));
      }, timeoutMs);
      timer.unref();
      this.calls.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  respond(id: RpcId, result: Json) {
    this.send({ id, result });
  }

  private reject(id: RpcId, message: string) {
    this.send({ id, error: { code: -32000, message } });
  }

  listen(threadId: string, listener: ThreadListener) {
    this.threads.set(threadId, listener);
    this.touch();
  }

  unlisten(threadId: string) {
    if (!this.threads.delete(threadId)) return;
    this.request("thread/unsubscribe", { threadId }).catch(() => {});
    this.touch();
  }

  kill() {
    this.die(new ModelUnavailableError("Codex app-server stopped"));
    this.proc.kill();
  }

  private send(message: Json) {
    if (!this.dead) this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  /** Exit when nothing has used this server for a while. */
  private touch() {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    if (this.threads.size || this.dead) return;
    this.idle = setTimeout(() => this.kill(), IDLE_MS);
    this.idle.unref();
  }

  private die(error: Error) {
    if (this.dead) return;
    this.dead = error;
    if (servers.get(this.key) === this) servers.delete(this.key);
    if (this.idle) clearTimeout(this.idle);
    for (const call of this.calls.values()) {
      clearTimeout(call.timer);
      call.reject(error);
    }
    this.calls.clear();
    for (const listener of this.threads.values()) listener.exit(error);
    this.threads.clear();
  }

  private receive(line: string) {
    let msg: Json;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id !== undefined && msg.method === undefined) {
      const call = this.calls.get(msg.id);
      if (!call) return;
      this.calls.delete(msg.id);
      clearTimeout(call.timer);
      if (msg.error) call.reject(new Error(String(msg.error.message ?? "Codex app-server error")));
      else call.resolve(msg.result);
      return;
    }
    const params = msg.params ?? {};
    const listener = this.threads.get(params.threadId ?? params.conversationId);
    if (msg.id === undefined) {
      listener?.notification(msg.method, params);
      return;
    }
    this.serverRequest(msg.id, msg.method, params, listener);
  }

  /** Codex asking the client: z answers only its own tools; everything else is refused. */
  private serverRequest(id: RpcId, method: string, params: Json, listener: ThreadListener | undefined) {
    switch (method) {
      case "item/tool/call":
        if (listener) return listener.toolCall(id, params);
        return this.respond(id, { success: false, contentItems: [{ type: "inputText", text: "No z run is waiting for this call." }] });
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
        listener?.refused(method, params);
        return this.respond(id, { decision: "decline" });
      case "execCommandApproval":
      case "applyPatchApproval":
        listener?.refused(method, params);
        return this.respond(id, { decision: { denied: { rejection: REFUSAL } } });
      case "mcpServer/elicitation/request":
        listener?.refused(method, params);
        return this.respond(id, { action: "decline", content: null, _meta: null });
      default:
        // Permission grants, user-input prompts, token refreshes (Codex owns sign-in), attestation…
        listener?.refused(method, params);
        return this.reject(id, `${method} is not supported by z. ${REFUSAL}`);
    }
  }
}

/** Stop every Codex app-server z started (tests, shutdown). */
export function closeCodexServers() {
  for (const server of [...servers.values()]) server.kill();
}

// ─── Sign-in, models, test ──────────────────────────────────────────────────

/** Who the Codex CLI is signed in as. Throws when the CLI can't be started. */
export async function codexAccount(p: Pick<ProviderConfig, "command">): Promise<CodexAccount> {
  const server = await AppServer.for(codexCommand(p));
  return readAccount(server);
}

async function readAccount(server: AppServer): Promise<CodexAccount> {
  const r = await server.request<{ account: Json; requiresOpenaiAuth: boolean }>("account/read", { refreshToken: false });
  const a = r.account;
  if (!a) return r.requiresOpenaiAuth ? { signedIn: false } : { signedIn: true, method: "other" };
  if (a.type === "chatgpt") return { signedIn: true, method: "chatgpt", email: a.email ?? null, plan: a.planType ?? null };
  return { signedIn: true, method: a.type === "apiKey" ? "apiKey" : "other" };
}

/** Models the Codex CLI offers this account (the default first). */
export async function listCodexModels(p: Pick<ProviderConfig, "command">): Promise<string[]> {
  const server = await AppServer.for(codexCommand(p));
  const r = await server.request<{ data: { id: string; hidden: boolean; isDefault: boolean }[] }>("model/list", {});
  return r.data.filter((m) => !m.hidden).sort((a, b) => Number(b.isDefault) - Number(a.isDefault)).map((m) => m.id);
}

// ─── The language model ─────────────────────────────────────────────────────

type Breakdown = { inputTokens: number; cachedInputTokens: number; cacheWriteInputTokens: number; outputTokens: number; reasoningOutputTokens: number };
type Event = { kind: "note"; method: string; params: Json } | { kind: "tool"; id: RpcId; params: Json } | { kind: "exit"; error: Error };

/** Codex turns paused on a tool call z is running (or asking about), by call id. */
const paused = new Map<string, Turn>();

/** One Codex turn, which may span several AI SDK steps (one per round of tool calls). */
class Turn {
  turnId: string | null = null;
  done = false;
  private queue: Event[] = [];
  private wake: (() => void) | null = null;
  /** Tool calls awaiting z's result: call id → JSON-RPC request id. */
  readonly waiting = new Map<string, RpcId>();
  private expiry: NodeJS.Timeout | null = null;
  private total: Breakdown | null = null;
  private reported = { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0 };

  readonly server: AppServer;
  readonly threadId: string;
  readonly modelId: string;

  constructor(server: AppServer, threadId: string, modelId: string) {
    this.server = server;
    this.threadId = threadId;
    this.modelId = modelId;
    server.listen(threadId, {
      notification: (method, params) => {
        if (method === "thread/tokenUsage/updated") this.total = params.tokenUsage?.total ?? this.total;
        this.push({ kind: "note", method, params });
      },
      toolCall: (id, params) => this.push({ kind: "tool", id, params }),
      refused: () => {},
      exit: (error) => {
        // A stream reading this turn fails; a paused one is forgotten, so its results replay into a new thread.
        this.push({ kind: "exit", error });
        this.end(false);
      },
    });
  }

  private push(event: Event) {
    this.queue.push(event);
    this.wake?.();
  }

  /** The next event, or null when none arrives within `ms`. */
  async next(ms?: number): Promise<Event | null> {
    while (!this.queue.length) {
      const arrived = await new Promise<boolean>((resolve) => {
        const timer = ms === undefined ? null : setTimeout(() => resolve(false), ms);
        this.wake = () => {
          if (timer) clearTimeout(timer);
          resolve(true);
        };
      });
      this.wake = null;
      if (!arrived) return null;
    }
    return this.queue.shift()!;
  }

  /** Usage since the last step that reported it. */
  usage(): LanguageModelV4Usage {
    const t = this.total;
    if (!t) return emptyUsage();
    const d = {
      input: t.inputTokens - this.reported.input,
      cached: t.cachedInputTokens - this.reported.cached,
      cacheWrite: (t.cacheWriteInputTokens ?? 0) - this.reported.cacheWrite,
      output: t.outputTokens - this.reported.output,
      reasoning: t.reasoningOutputTokens - this.reported.reasoning,
    };
    this.reported = { input: t.inputTokens, cached: t.cachedInputTokens, cacheWrite: t.cacheWriteInputTokens ?? 0, output: t.outputTokens, reasoning: t.reasoningOutputTokens };
    return {
      inputTokens: { total: d.input, noCache: d.input - d.cached, cacheRead: d.cached, cacheWrite: d.cacheWrite },
      outputTokens: { total: d.output, text: d.output - d.reasoning, reasoning: d.reasoning },
      raw: { ...t },
    };
  }

  /** A step ended on tool calls: hold the turn for the results, but not forever. */
  pause() {
    this.expiry = setTimeout(() => this.end(true), PAUSE_MS);
    this.expiry.unref();
  }

  resume() {
    if (this.expiry) clearTimeout(this.expiry);
    this.expiry = null;
  }

  answer(callId: string, output: LanguageModelV4ToolResultOutput) {
    const id = this.waiting.get(callId);
    if (id === undefined) return;
    this.waiting.delete(callId);
    paused.delete(callId);
    this.server.respond(id, { success: !/^(error-text|error-json|execution-denied)$/.test(output.type), contentItems: [{ type: "inputText", text: toolOutputText(output) }] });
  }

  /** Finish with this turn; `interrupt` stops it at Codex too. */
  end(interrupt: boolean) {
    this.resume();
    for (const callId of this.waiting.keys()) paused.delete(callId);
    this.waiting.clear();
    if (this.done) return;
    this.done = true;
    // Wake a stream still reading this turn.
    this.push({ kind: "exit", error: new ModelUnavailableError("Codex turn stopped") });
    if (interrupt && this.turnId) this.server.request("turn/interrupt", { threadId: this.threadId, turnId: this.turnId }).catch(() => {});
    this.server.unlisten(this.threadId);
  }
}

const emptyUsage = (): LanguageModelV4Usage => ({
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
});

export function createCodexModel(p: ProviderConfig, modelId: string): LanguageModelV4 {
  const model: LanguageModelV4 = {
    specificationVersion: "v4",
    provider: "codex-cli",
    modelId,
    supportedUrls: {},
    doStream: (options) => doStream(p, modelId, options),
    doGenerate: async (options) => {
      const { stream } = await doStream(p, modelId, options);
      const content: LanguageModelV4Content[] = [];
      const open = new Map<string, { type: "text" | "reasoning"; text: string }>();
      let finishReason: LanguageModelV4FinishReason = { unified: "other", raw: undefined };
      let usage = emptyUsage();
      let warnings: SharedV4Warning[] = [];
      const reader = stream.getReader();
      for (;;) {
        const { value: part, done } = await reader.read();
        if (done) break;
        switch (part.type) {
          case "stream-start":
            warnings = part.warnings;
            break;
          case "text-start":
          case "reasoning-start":
            open.set(part.id, { type: part.type === "text-start" ? "text" : "reasoning", text: "" });
            break;
          case "text-delta":
          case "reasoning-delta":
            open.get(part.id)!.text += part.delta;
            break;
          case "text-end":
          case "reasoning-end": {
            const block = open.get(part.id)!;
            content.push({ type: block.type, text: block.text });
            break;
          }
          case "tool-call":
            content.push(part);
            break;
          case "finish":
            finishReason = part.finishReason;
            usage = part.usage;
            break;
          case "error":
            throw part.error;
        }
      }
      return { content, finishReason, usage, warnings };
    },
  };
  return model;
}

async function doStream(p: ProviderConfig, modelId: string, options: LanguageModelV4CallOptions) {
  const warnings: SharedV4Warning[] = [];
  const turn = continuation(options) ?? (await startTurn(p, modelId, options, warnings));
  const signal = options.abortSignal;
  const onAbort = () => turn.end(true);
  signal?.addEventListener("abort", onAbort, { once: true });

  const step = new Step(turn);
  // Read up to the first output so a turn that fails at once (usage limit, unknown model) throws here,
  // where a fallback chain can still try the next model.
  const first: LanguageModelV4StreamPart[] = [];
  try {
    while (!step.finished && !first.some(isOutput)) first.push(...(await step.advance()));
  } catch (error) {
    signal?.removeEventListener("abort", onAbort);
    throw error;
  }

  const stream = new ReadableStream<LanguageModelV4StreamPart>({
    start: async (controller) => {
      controller.enqueue({ type: "stream-start", warnings });
      controller.enqueue({ type: "response-metadata", id: turn.turnId ?? undefined, modelId: turn.modelId });
      try {
        for (const part of first) controller.enqueue(part);
        while (!step.finished) for (const part of await step.advance()) controller.enqueue(part);
      } catch (error) {
        controller.enqueue({ type: "error", error });
        controller.enqueue({ type: "finish", finishReason: { unified: "error", raw: undefined }, usage: turn.usage() });
      } finally {
        signal?.removeEventListener("abort", onAbort);
        controller.close();
      }
    },
  });
  return { stream, request: { body: { threadId: turn.threadId, turnId: turn.turnId } } };
}

const isOutput = (part: LanguageModelV4StreamPart) => part.type !== "finish";

/** The paused Codex turn this prompt's tool results answer, with the results handed over; else null. */
function continuation(options: LanguageModelV4CallOptions): Turn | null {
  const last = options.prompt.at(-1);
  if (last?.role !== "tool") return null;
  const results = last.content.filter((part) => part.type === "tool-result");
  const turn = results.map((r) => paused.get(r.toolCallId)).find((t) => t && !t.done);
  if (!turn) return null;
  turn.resume();
  for (const r of results) turn.answer(r.toolCallId, r.output);
  return turn;
}

/** A fresh ephemeral thread carrying the conversation so far, and a turn on its latest message. */
async function startTurn(p: ProviderConfig, modelId: string, options: LanguageModelV4CallOptions, warnings: SharedV4Warning[]): Promise<Turn> {
  const server = await AppServer.for(codexCommand(p));
  if (!(await readAccount(server)).signedIn) throw new CodexNotSignedInError();
  const { instructions, history, input } = toCodexPrompt(options, warnings);

  const offered = options.toolChoice?.type === "none" ? [] : (options.tools ?? []);
  const dynamicTools = offered.flatMap((t) => {
    if (t.type === "function") return [{ type: "function", name: t.name, description: t.description ?? "", inputSchema: t.inputSchema }];
    warnings.push({ type: "unsupported", feature: `provider tool ${t.name}`, details: "Codex runs only z's own tools." });
    return [];
  });
  for (const feature of ["temperature", "topP", "topK", "seed", "stopSequences", "presencePenalty", "frequencyPenalty", "maxOutputTokens"] as const) {
    if (options[feature] !== undefined) warnings.push({ type: "unsupported", feature });
  }

  const started = await server.request<{ thread: { id: string }; model: string }>("thread/start", {
    ...(modelId && modelId !== "default" ? { model: modelId } : {}),
    cwd: server.cwd,
    sandbox: "read-only",
    approvalPolicy: "untrusted",
    ephemeral: true,
    serviceName: "z",
    baseInstructions: instructions,
    dynamicTools,
  });
  const turn = new Turn(server, started.thread.id, started.model ?? modelId);
  try {
    if (history.length) await server.request("thread/inject_items", { threadId: turn.threadId, items: history });
    const effort = options.reasoning && options.reasoning !== "provider-default" && options.reasoning !== "none" ? options.reasoning : undefined;
    const r = await server.request<{ turn: { id: string } }>("turn/start", { threadId: turn.threadId, input, ...(effort ? { effort } : {}) });
    turn.turnId = r.turn.id;
  } catch (error) {
    turn.end(false);
    throw error;
  }
  return turn;
}

/** Turns Codex events into stream parts, one AI SDK step at a time. */
class Step {
  finished = false;
  private text = new Set<string>();
  private reasoning = new Map<string, "summary" | "content">();
  private calls = 0;

  private turn: Turn;

  constructor(turn: Turn) {
    this.turn = turn;
  }

  /** The parts for the next event (or the step's finish). */
  async advance(): Promise<LanguageModelV4StreamPart[]> {
    const turn = this.turn;
    if (turn.done && !this.calls) {
      this.finished = true;
      throw new ModelUnavailableError("This Codex turn was already stopped");
    }
    // After a tool call, the step ends once Codex has gone quiet (it is waiting for z's results).
    const event = await turn.next(this.calls ? GATHER_MS : undefined);
    if (!event) {
      this.finished = true;
      turn.pause();
      return [{ type: "finish", finishReason: { unified: "tool-calls", raw: "dynamicToolCall" }, usage: turn.usage() }];
    }
    if (event.kind === "exit") {
      this.finished = true;
      turn.end(false);
      throw event.error;
    }
    if (event.kind === "tool") {
      const { callId, tool, namespace, arguments: args } = event.params;
      this.calls++;
      turn.waiting.set(callId, event.id);
      paused.set(callId, turn);
      return [{ type: "tool-call", toolCallId: callId, toolName: namespace ? `${namespace}_${tool}` : tool, input: JSON.stringify(args ?? {}) }];
    }
    return this.note(event.method, event.params);
  }

  private note(method: string, params: Json): LanguageModelV4StreamPart[] {
    switch (method) {
      case "item/agentMessage/delta": {
        const start: LanguageModelV4StreamPart[] = this.text.has(params.itemId) ? [] : [{ type: "text-start", id: params.itemId }];
        this.text.add(params.itemId);
        return [...start, { type: "text-delta", id: params.itemId, delta: params.delta }];
      }
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta": {
        const kind = method === "item/reasoning/summaryTextDelta" ? "summary" : "content";
        const seen = this.reasoning.get(params.itemId);
        // A model that streams both its summary and its raw reasoning: show the summary.
        if (seen && seen !== kind) return [];
        this.reasoning.set(params.itemId, kind);
        return [...(seen ? [] : [{ type: "reasoning-start" as const, id: params.itemId }]), { type: "reasoning-delta", id: params.itemId, delta: params.delta }];
      }
      case "item/completed":
        return this.completed(params.item);
      case "turn/completed": {
        this.finished = true;
        this.turn.end(false);
        const t = params.turn ?? {};
        if (t.status === "failed") throw turnError(t.error);
        return [{ type: "finish", finishReason: { unified: t.status === "interrupted" ? "other" : "stop", raw: t.status }, usage: this.turn.usage() }];
      }
      default:
        return [];
    }
  }

  private completed(item: Json): LanguageModelV4StreamPart[] {
    if (item.type === "agentMessage") {
      if (this.text.has(item.id)) return [{ type: "text-end", id: item.id }];
      if (!item.text) return [];
      this.text.add(item.id);
      return [
        { type: "text-start", id: item.id },
        { type: "text-delta", id: item.id, delta: item.text },
        { type: "text-end", id: item.id },
      ];
    }
    if (item.type === "reasoning") return this.reasoning.has(item.id) ? [{ type: "reasoning-end", id: item.id }] : [];
    // A built-in tool that ran despite the lockdown: stop the turn rather than let it go on.
    if (!CONVERSATION_ITEMS.has(item.type) && item.status !== "declined" && item.status !== "failed") {
      this.finished = true;
      this.turn.end(true);
      throw new Error(`Codex used its built-in ${item.type} tool, which z does not allow; the turn was stopped`);
    }
    return [];
  }
}

function turnError(error: Json): Error {
  const message = String(error?.message ?? "Codex turn failed");
  const info = error?.codexErrorInfo;
  const code = typeof info === "string" ? info : info && typeof info === "object" ? Object.keys(info)[0] : undefined;
  const status = info && typeof info === "object" ? Object.values(info as Record<string, { httpStatusCode?: number }>)[0]?.httpStatusCode : undefined;
  const api = (statusCode: number) =>
    new APICallError({ message, url: "codex://app-server", requestBodyValues: {}, statusCode, responseBody: error?.additionalDetails ?? undefined, isRetryable: false });
  switch (code) {
    case "unauthorized":
      return new ModelUnavailableError(`${message} — run \`codex login\` again on this server's machine`);
    case "usageLimitExceeded":
    case "rateLimitExceeded":
      return api(429);
    case "modelNotFound":
      return api(404);
    case "serverOverloaded":
    case "internalServerError":
      return api(503);
    default:
      return status ? api(status) : new Error(message);
  }
}

// ─── Prompt conversion ──────────────────────────────────────────────────────

type CodexPrompt = { instructions: string; history: Json[]; input: Json[] };

/**
 * System messages become the thread's base instructions (replacing Codex's coding-agent prompt);
 * earlier turns become injected Responses items; the last user message is the turn's input.
 * A prompt ending in tool results (a pause Codex gave up on) replays them and asks to go on.
 */
function toCodexPrompt(options: LanguageModelV4CallOptions, warnings: SharedV4Warning[]): CodexPrompt {
  const system = options.prompt.filter((m) => m.role === "system").map((m) => m.content);
  const rest = options.prompt.filter((m) => m.role !== "system");
  if (options.responseFormat?.type === "json") {
    system.push(
      options.responseFormat.schema
        ? `Reply with a single JSON object matching this JSON schema, and nothing else:\n${JSON.stringify(options.responseFormat.schema)}`
        : "Reply with a single JSON object, and nothing else.",
    );
  }
  const last = rest.at(-1);
  const history = (last?.role === "user" ? rest.slice(0, -1) : rest).flatMap((m) => toItems(m, warnings));
  const input =
    last?.role === "user"
      ? last.content.flatMap((part) => (part.type === "text" ? [{ type: "text", text: part.text, text_elements: [] }] : fileInput(part, warnings)))
      : [{ type: "text", text: "Continue from the tool results above.", text_elements: [] }];
  return { instructions: system.join("\n\n") || "You are a helpful assistant.", history, input };
}

function toItems(m: LanguageModelV4Message, warnings: SharedV4Warning[]): Json[] {
  switch (m.role) {
    case "system":
      return [];
    case "user": {
      const content = m.content.flatMap((part) =>
        part.type === "text" ? [{ type: "input_text", text: part.text }] : fileInput(part, warnings).map((f) => (f.type === "image" ? { type: "input_image", image_url: f.url } : { type: "input_text", text: f.text })),
      );
      return content.length ? [{ type: "message", role: "user", content }] : [];
    }
    case "assistant":
      return m.content.flatMap((part): Json[] => {
        if (part.type === "text" && part.text) return [{ type: "message", role: "assistant", content: [{ type: "output_text", text: part.text }] }];
        if (part.type === "tool-call" && !part.providerExecuted) return [{ type: "function_call", name: part.toolName, arguments: JSON.stringify(part.input ?? {}), call_id: part.toolCallId }];
        return [];
      });
    case "tool":
      return m.content.flatMap((part) => (part.type === "tool-result" ? [{ type: "function_call_output", call_id: part.toolCallId, output: toolOutputText(part.output) }] : []));
  }
}

/** Images go to Codex as URLs (data URLs for bytes); inline text files as text; other files are left out. */
function fileInput(part: Json, warnings: SharedV4Warning[]): Json[] {
  const data = part.data;
  if (data?.type === "text") return [{ type: "text", text: data.text, text_elements: [] }];
  if (String(part.mediaType).startsWith("image")) {
    if (data?.type === "url") return [{ type: "image", url: String(data.url) }];
    if (data?.type === "data") {
      const base64 = typeof data.data === "string" ? data.data : Buffer.from(data.data).toString("base64");
      const media = String(part.mediaType).includes("/") ? part.mediaType : "image/png";
      return [{ type: "image", url: `data:${media};base64,${base64}` }];
    }
  }
  warnings.push({ type: "unsupported", feature: `file ${part.mediaType}`, details: "Codex receives images and text only." });
  return [{ type: "text", text: `[file left out: ${part.filename ?? part.mediaType}]`, text_elements: [] }];
}

function toolOutputText(output: LanguageModelV4ToolResultOutput): string {
  switch (output.type) {
    case "text":
      return output.value;
    case "error-text":
      return `Error: ${output.value}`;
    case "json":
      return JSON.stringify(output.value);
    case "error-json":
      return `Error: ${JSON.stringify(output.value)}`;
    case "execution-denied":
      return `The owner did not allow this call${output.reason ? `: ${output.reason}` : ""}.`;
    case "content":
      return output.value.map((part) => (part.type === "text" ? part.text : `[${part.type}]`)).join("\n");
  }
}
