import assert from "node:assert/strict";
import { test } from "node:test";
import { runTask, Settings, type ModelResolver, type Task } from "@z/core";
import type { ModelMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";

test("task resumes send a compacted history to the model but persist the full one", async () => {
  const sentChars: number[] = [];
  const model = new MockLanguageModelV4({
    doGenerate: (async (options: { prompt: unknown }) => {
      sentChars.push(JSON.stringify(options.prompt).length);
      return {
        content: [{ type: "text", text: "All done." }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 2, text: 2, reasoning: 0 } },
        warnings: [],
      };
    }) as any,
  });
  const models = { forLane: () => model, chain: () => model, contextWindow: () => 8_000 } as unknown as ModelResolver;

  // A long-running task: twelve earlier tool results of ~20k chars each (≈ 70k tokens) before it resumed.
  const history: ModelMessage[] = [{ role: "user", content: "Collect the release notes." }];
  for (let i = 0; i < 12; i++) {
    history.push({ role: "assistant", content: [{ type: "tool-call", toolCallId: `c${i}`, toolName: "web_fetch_page", input: { url: `https://example.com/${i}` } }] });
    history.push({ role: "tool", content: [{ type: "tool-result", toolCallId: `c${i}`, toolName: "web_fetch_page", output: { type: "text", value: `page ${i} `.repeat(2_500) } }] });
  }
  const fullChars = JSON.stringify(history).length;

  const now = new Date().toISOString();
  const task = { id: "t1", title: "Notes", instructions: "Collect the release notes.", schedule: null, tools: null, lane: "agent", status: "running", result: null, error: null, events: [], nextRunAt: null, createdAt: now, updatedAt: now } as unknown as Task;
  let persisted: ModelMessage[] = [];
  const outcome = await runTask(
    task,
    { models, routing: { agent: ["p:m"] }, settings: Settings.parse({}), plugins: [] } as any,
    { messages: history, onEvent: () => {}, onMessages: (m) => (persisted = m) },
  );

  assert.equal(outcome.status, "done");
  assert.ok(sentChars[0]! < fullChars / 4, `model got ${sentChars[0]} chars of a ${fullChars}-char history`);
  assert.ok(outcome.messages.length > history.length, "the outcome keeps every earlier message plus the new reply");
  assert.deepEqual(outcome.messages.slice(0, history.length), history, "persisted history is untouched");
  assert.ok(persisted.length === 0 || persisted.length > history.length);
});
