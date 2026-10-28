/**
 * Test harness: the real server pieces (node:sqlite in a temp dir, store, plugins, bus, delivery, task engine)
 * with only the language model replaced by the AI SDK's MockLanguageModelV4.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { definePlugin, type ZPlugin } from "@z/core";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { createBus } from "../src/bus.ts";
import { createChannels } from "../src/channels.ts";
import { createConnectors } from "../src/connectors.ts";
import { createSealer } from "../src/crypto.ts";
import { openDatabase } from "../src/db.ts";
import { loadEnv } from "../src/env.ts";
import { startDelivery, type Transports } from "../src/notify.ts";
import { createPairing } from "../src/owner.ts";
import { createPluginRegistry } from "../src/plugins.ts";
import { createPush } from "../src/push.ts";
import { createRuntime } from "../src/runtime.ts";
import { createStore, type Store } from "../src/store.ts";
import { createTasks } from "../src/tasks.ts";

export const tempDir = (prefix = "z-test-") => mkdtempSync(join(tmpdir(), prefix));

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

/** One scripted model reply. `hang` waits until the call is aborted (a model call in flight at a crash). */
export type Reply = { text: string } | { call: string; input: unknown; id?: string } | "hang";

let callSeq = 0;
function toResult(reply: Exclude<Reply, "hang">) {
  if ("text" in reply) {
    return { content: [{ type: "text", text: reply.text }], finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [] };
  }
  return {
    content: [{ type: "tool-call", toolCallId: reply.id ?? `call-${++callSeq}`, toolName: reply.call, input: JSON.stringify(reply.input) }],
    finishReason: { unified: "tool-calls", raw: "tool_calls" },
    usage,
    warnings: [],
  };
}

/** A mock model that answers from a queue; `prompts` records what each call was sent. */
export function scriptedModel() {
  const queue: Reply[] = [];
  const model = new MockLanguageModelV4({
    doGenerate: (async (options: { abortSignal?: AbortSignal }) => {
      const reply = queue.shift();
      if (!reply) throw new Error("scripted model: no reply queued");
      if (reply === "hang") {
        return new Promise((_, reject) => {
          const signal = options.abortSignal;
          signal?.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
        });
      }
      return toResult(reply);
    }) as any,
  });
  return { model, push: (...replies: Reply[]) => queue.push(...replies), pending: () => queue.length };
}

/** A plugin with a write tool whose executions are counted and can be held open. */
export function testPlugin() {
  const executed: unknown[] = [];
  let hold: Promise<void> | null = null;
  const plugin: ZPlugin = definePlugin({
    id: "test",
    name: "Test",
    description: "Tools for engine tests.",
    tools: {
      send: {
        description: "Send a message",
        risk: "write",
        defaultPolicy: "allow",
        inputSchema: z.object({ to: z.string() }),
        summarize: (input: { to: string }) => `Send a message to ${input.to}`,
        execute: async (input: unknown, ctx) => {
          executed.push(input);
          if (hold) {
            await Promise.race([
              hold,
              new Promise((_, reject) => ctx.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })),
            ]);
          }
          return { sent: true };
        },
      },
    },
    briefing: async () => {
      throw new Error("feed is down");
    },
  });
  return {
    plugin,
    executed,
    /** Make `send` block until released (or the run is aborted). */
    holdOpen: () => {
      let release!: () => void;
      hold = new Promise<void>((resolve) => (release = resolve));
      return () => {
        hold = null;
        release();
      };
    },
  };
}

/**
 * Options for a booted "process". `now`: a fake clock for the task engine and the outbox (its retry
 * timers are then off: tests call `outbox.runDue()`). `transports`: stand-ins for the push service
 * and the owner channel's platform, the network edge only.
 */
export type BootOptions = { now?: () => Date; transports?: Partial<Transports> };

/** One "process": runtime + engine over a data dir. Call again on the same dir to simulate a restart. */
export function boot(dataDir: string, plugins: ZPlugin[], model: MockLanguageModelV4, options: BootOptions = {}) {
  process.env.Z_DATA_DIR = dataDir;
  const env = loadEnv();
  const store = createStore(openDatabase(env.dataDir), createSealer(env.masterKey));
  const bus = createBus();
  const registry = createPluginRegistry(plugins, store);
  const connectors = createConnectors(env, store, bus);
  const real = createRuntime(env, store, registry, bus, connectors);
  const models = { ...real.models, forLane: () => model, chain: () => model };
  const rt = {
    ...real,
    models,
    deps: (scope: string) => ({ ...real.deps(scope), models }),
    ownerDeps: (scope: string) => ({ ...real.ownerDeps(scope), models }),
  };
  const { now } = options;
  const tasks = createTasks(rt, now ? { now } : {});
  const outbox = startDelivery(
    rt,
    options.transports?.push ?? createPush(rt),
    options.transports?.channels ?? createChannels(rt, tasks, createPairing()),
    now ? { now: () => now().getTime(), timers: false } : {},
  );
  return { rt, store, tasks, outbox };
}

export async function until(check: () => boolean, what: string, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

export const statusOf = (store: Store, id: string) => store.tasks.get(id)?.status;

export const cleanup = (dir: string) => rmSync(dir, { recursive: true, force: true });
