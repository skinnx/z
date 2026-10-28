import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { registerSecret } from "./secrets.ts";

export type Env = {
  port: number;
  /** HOST: the address to listen on; null listens on every interface. */
  host: string | null;
  dataDir: string;
  masterKey: Buffer;
  /** `env`: Z_MASTER_KEY; `file`: `master.key` in the data dir, which the owner must back up. */
  masterKeySource: "env" | "file";
  token: string | null;
  publicUrl: string | null;
  plugins: string[];
  /** Z_ALLOW_PRIVATE_MCP=1: connectors may reach localhost, the LAN and plain http (self-hosted MCP servers). */
  allowPrivateMcp: boolean;
};

export function loadEnv(): Env {
  const dataDir = resolve(process.env.Z_DATA_DIR ?? "./.data");
  mkdirSync(dataDir, { recursive: true });
  const fromEnv = Boolean(process.env.Z_MASTER_KEY?.trim());
  const masterKey = loadMasterKey(dataDir);
  const token = process.env.Z_TOKEN || null;
  // Both are secrets: log output redacts them from here on, in every encoding they could be printed in.
  registerSecret(token);
  registerSecret(process.env.Z_MASTER_KEY?.trim());
  for (const encoding of ["hex", "base64", "base64url"] as const) registerSecret(masterKey.toString(encoding));
  return {
    port: Number(process.env.PORT ?? 8787),
    host: process.env.HOST?.trim() || null,
    dataDir,
    masterKey,
    masterKeySource: fromEnv ? "env" : "file",
    token,
    publicUrl: process.env.Z_PUBLIC_URL?.replace(/\/+$/, "") || null,
    plugins: (process.env.Z_PLUGINS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    allowPrivateMcp: process.env.Z_ALLOW_PRIVATE_MCP === "1",
  };
}

export const masterKeyFile = (dataDir: string) => join(dataDir, "master.key");

function loadMasterKey(dataDir: string): Buffer {
  const fromEnv = process.env.Z_MASTER_KEY?.trim();
  if (fromEnv) return parseKey(fromEnv, "Z_MASTER_KEY");

  const file = masterKeyFile(dataDir);
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
