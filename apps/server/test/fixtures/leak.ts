/**
 * Child process for the redaction test: a provider whose server quotes the key back in its error,
 * logged every way the server logs (console, the core log dep, raw writes, a crash).
 * argv: <data dir> <provider key>
 */
import { createServer } from "node:http";
import { testProvider } from "@z/core";
import { createSealer } from "../../src/crypto.ts";
import { openDatabase } from "../../src/db.ts";
import { loadEnv } from "../../src/env.ts";
import { installRedaction } from "../../src/secrets.ts";
import { createStore } from "../../src/store.ts";

installRedaction();
const [dataDir, key] = process.argv.slice(2) as [string, string];
process.env.Z_DATA_DIR = dataDir;
const env = loadEnv();

// The stored key is written by one "process" and read back by this one, as after a restart.
const writer = createStore(openDatabase(env.dataDir), createSealer(env.masterKey));
const server = createServer((req, res) => {
  const sent = (req.headers.authorization ?? "").replace(/^Bearer /, "");
  res.writeHead(401, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message: `Incorrect API key provided: ${sent}`, type: "invalid_request_error" } }));
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
writer.providers.upsert({ id: "leaky", kind: "openai-compatible", label: "Leaky", baseURL: `http://127.0.0.1:${port}/v1`, models: ["m"], enabled: true }, key);

const store = createStore(openDatabase(env.dataDir), createSealer(env.masterKey));
store.openAllSecrets();
const provider = store.providers.get("leaky")!;
const result = await testProvider(provider);
server.close();

console.error(`[z] provider test failed: ${result.error}`);
console.log("[z:chat] model error", new Error(`401 ${result.error}`));
console.warn({ provider: "leaky", detail: result.error });
process.stdout.write(Buffer.from(`raw bytes ${key}\n`));
throw new Error(`crash while using ${key}`);
