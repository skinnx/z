import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export type Env = {
  port: number;
  dataDir: string;
  masterKey: Buffer;
  token: string | null;
  publicUrl: string | null;
  plugins: string[];
  /** Z_ALLOW_PRIVATE_MCP=1: connectors may reach localhost, the LAN and plain http (self-hosted MCP servers). */
  allowPrivateMcp: boolean;
};

export function loadEnv(): Env {
  const dataDir = resolve(process.env.Z_DATA_DIR ?? "./.data");
  mkdirSync(dataDir, { recursive: true });
  return {
    port: Number(process.env.PORT ?? 8787),
    dataDir,
    masterKey: loadMasterKey(dataDir),
    token: process.env.Z_TOKEN || null,
    publicUrl: process.env.Z_PUBLIC_URL?.replace(/\/+$/, "") || null,
    plugins: (process.env.Z_PLUGINS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    allowPrivateMcp: process.env.Z_ALLOW_PRIVATE_MCP === "1",
  };
}

function loadMasterKey(dataDir: string): Buffer {
  const fromEnv = process.env.Z_MASTER_KEY?.trim();
  if (fromEnv) return parseKey(fromEnv, "Z_MASTER_KEY");

  const file = join(dataDir, "master.key");
  if (existsSync(file)) return parseKey(readFileSync(file, "utf8").trim(), file);

  const key = randomBytes(32);
  writeFileSync(file, key.toString("base64") + "\n", { mode: 0o600 });
  console.log(`[z] Generated a new master key at ${file}. Back it up: stored secrets cannot be decrypted without it.`);
  return key;
}

function parseKey(value: string, source: string): Buffer {
  const key = /^[0-9a-f]{64}$/i.test(value) ? Buffer.from(value, "hex") : Buffer.from(value, "base64");
  if (key.length !== 32) throw new Error(`${source} must be a 32-byte key encoded as hex or base64`);
  return key;
}
