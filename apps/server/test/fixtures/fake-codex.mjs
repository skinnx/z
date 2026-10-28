#!/usr/bin/env node
// A stand-in for `codex app-server`: JSON-RPC over stdio, scripted by the turn's text.
// FAKE_CODEX_LOG: file that receives one JSON line per message z sends (and per answer to our requests).
// FAKE_CODEX_SIGNED_OUT=1: account/read reports no sign-in, as a fresh `codex` install does.
// Scenarios (the user message starts with): "stream", "tool", "builtin", "ran-anyway"; anything else: echo.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const log = (entry) => process.env.FAKE_CODEX_LOG && appendFileSync(process.env.FAKE_CODEX_LOG, `${JSON.stringify(entry)}\n`);
log({ argv: process.argv.slice(2), cwd: process.cwd(), env: Object.keys(process.env) });
const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const notify = (method, params) => send({ method, params });

let seq = 0;
const waiting = new Map();
/** Ask z something and wait for its answer. */
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = `srv-${++seq}`;
    waiting.set(id, resolve);
    send({ id, method, params });
  });

let threads = 0;
const usage = (n) => ({ total: { totalTokens: 15 * n, inputTokens: 10 * n, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 5 * n, reasoningOutputTokens: n }, last: null, modelContextWindow: 200000 });

async function runTurn(threadId, turnId, text) {
  const item = (type, extra) => ({ type, id: `${type}-${turnId}`, ...extra });
  const say = (message) => {
    const id = `msg-${turnId}-${++seq}`;
    notify("item/started", { threadId, turnId, item: { type: "agentMessage", id, text: "" } });
    for (const delta of message.match(/.{1,4}/g) ?? []) notify("item/agentMessage/delta", { threadId, turnId, itemId: id, delta });
    notify("item/completed", { threadId, turnId, item: { type: "agentMessage", id, text: message } });
  };
  const done = (status = "completed", error = null) => {
    notify("thread/tokenUsage/updated", { threadId, turnId, tokenUsage: usage(1) });
    notify("turn/completed", { threadId, turn: { id: turnId, status, error, items: [] } });
  };
  notify("turn/started", { threadId, turn: { id: turnId, status: "inProgress" } });

  if (text.startsWith("stream")) {
    const r = item("reasoning", { summary: [], content: [] });
    notify("item/started", { threadId, turnId, item: r });
    notify("item/reasoning/summaryTextDelta", { threadId, turnId, itemId: r.id, delta: "Thinking", summaryIndex: 0 });
    notify("item/completed", { threadId, turnId, item: r });
    say("Hello from Codex");
    return done();
  }
  if (text.startsWith("tool")) {
    const answer = await ask("item/tool/call", { threadId, turnId, callId: `call-${turnId}`, namespace: null, tool: "test_send", arguments: { to: "bob" } });
    log({ toolAnswer: answer });
    say(`Tool said: ${answer.contentItems[0].text} (${answer.success ? "ok" : "failed"})`);
    return done();
  }
  if (text.startsWith("builtin")) {
    const cmd = item("commandExecution", { command: "rm -rf ~", status: "inProgress" });
    notify("item/started", { threadId, turnId, item: cmd });
    const answer = await ask("item/commandExecution/requestApproval", { threadId, turnId, itemId: cmd.id, command: "rm -rf ~" });
    log({ approvalAnswer: answer });
    notify("item/completed", { threadId, turnId, item: { ...cmd, status: answer.decision === "decline" ? "declined" : "completed" } });
    say(answer.decision === "decline" ? "The command was declined." : "I ran it.");
    return done();
  }
  if (text.startsWith("ran-anyway")) {
    notify("item/completed", { threadId, turnId, item: item("commandExecution", { command: "cat /etc/passwd", status: "completed" }) });
    // Codex would go on talking; z must have stopped the turn by now.
    say("Here is the file.");
    return done();
  }
  say(`echo: ${text}`);
  done();
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === undefined) {
    waiting.get(msg.id)?.(msg.result ?? { error: msg.error });
    waiting.delete(msg.id);
    return;
  }
  log({ method: msg.method, params: msg.params });
  const reply = (result) => send({ id: msg.id, result });
  switch (msg.method) {
    case "initialize":
      return reply({ userAgent: "fake-codex/0.0.0", codexHome: "/nonexistent", platformFamily: "unix", platformOs: "linux" });
    case "initialized":
      return;
    case "account/read":
      return reply(
        process.env.FAKE_CODEX_SIGNED_OUT === "1"
          ? { account: null, requiresOpenaiAuth: true, workspaceRouting: null }
          : { account: { type: "chatgpt", email: "owner@example.com", planType: "plus" }, requiresOpenaiAuth: true, workspaceRouting: null },
      );
    case "model/list":
      return reply({ data: [{ id: "gpt-fake-mini", hidden: false, isDefault: false }, { id: "gpt-fake", hidden: false, isDefault: true }, { id: "gpt-hidden", hidden: true, isDefault: false }], nextCursor: null });
    case "thread/start":
      return reply({ thread: { id: `thread-${++threads}` }, model: msg.params.model ?? "gpt-fake" });
    case "thread/inject_items":
    case "thread/unsubscribe":
      return reply({});
    case "turn/start": {
      const turnId = `turn-${++seq}`;
      reply({ turn: { id: turnId, status: "inProgress", items: [], error: null } });
      const text = msg.params.input.map((i) => i.text ?? "").join(" ");
      return void runTurn(msg.params.threadId, turnId, text);
    }
    case "turn/interrupt":
      reply({});
      return notify("turn/completed", { threadId: msg.params.threadId, turn: { id: msg.params.turnId, status: "interrupted", error: null, items: [] } });
    default:
      return send({ id: msg.id, error: { code: -32601, message: `fake-codex: ${msg.method} not scripted` } });
  }
});
