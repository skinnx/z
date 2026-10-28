import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { registerSecret } from "./secrets.ts";

export type Env = {
  port: number;
  /** Interface to listen on. Loopback unless Z_HOST says otherwise. */
  host: string;
  dataDir: string;
  masterKey: Buffer;
  /** `env`: Z_MASTER_KEY; `file`: `master.key` in the data dir, which the owner must back up. */
  masterKeySource: "env" | "file";
  token: string | null;
  /** `env`: Z_TOKEN; `generated`: `access.token` in the data dir (exposed without Z_TOKEN); null: no token (loopback). */
  tokenSource: "env" | "generated" | null;
  publicUrl: string | null;
  plugins: string[];
  /** Z_ALLOW_PRIVATE_MCP=1: connectors may reach localhost, the LAN and plain http (self-hosted MCP servers). */
  allowPrivateMcp: boolean;
};

export function loadEnv(): Env {
  const dataDir = resolve(process.env.Z_DATA_DIR ?? "./.data");
  mkdirSync(dataDir, { recursive: true });
  const host = process.env.Z_HOST?.trim() || "127.0.0.1";
  const fromEnv = Boolean(process.env.Z_MASTER_KEY?.trim());
  const masterKey = loadMasterKey(dataDir);
  const tokenSource = process.env.Z_TOKEN ? "env" : isLoopback(host) ? null : "generated";
  const token = tokenSource === "env" ? process.env.Z_TOKEN! : tokenSource === "generated" ? loadAccessToken(dataDir) : null;
  // All secrets: log output redacts them from here on, in every encoding they could be printed in.
  registerSecret(token);
  registerSecret(process.env.Z_MASTER_KEY?.trim());
  for (const encoding of ["hex", "base64", "base64url"] as const) registerSecret(masterKey.toString(encoding));
  return {
    port: Number(process.env.PORT ?? 8787),
    host,
    dataDir,
    masterKey,
    masterKeySource: fromEnv ? "env" : "file",
    token,
    tokenSource,
    publicUrl: process.env.Z_PUBLIC_URL?.replace(/\/+$/, "") || null,
    plugins: (process.env.Z_PLUGINS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    allowPrivateMcp: process.env.Z_ALLOW_PRIVATE_MCP === "1",
  };
}

export const masterKeyFile = (dataDir: string) => join(dataDir, "master.key");
export const accessTokenFile = (dataDir: string) => join(dataDir, "access.token");

export const isLoopback = (host: string) => host === "localhost" || host === "::1" || host.startsWith("127.");

/**
 * Reachable beyond this machine without Z_TOKEN: never run open. Use (or create) a random token in the
 * data dir; the log names the file, never the token.
 */
function loadAccessToken(dataDir: string): string {
  const file = accessTokenFile(dataDir);
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  const token = randomBytes(24).toString("base64url");
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  console.log(`[z] Listening beyond localhost without Z_TOKEN: generated an access token in ${file}. Enter it in the web app.`);
  return token;
}

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
