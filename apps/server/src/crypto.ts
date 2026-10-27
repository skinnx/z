/** AES-256-GCM for secrets at rest. Format: `v1.<iv>.<tag>.<ciphertext>` (base64url). */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export type Sealer = {
  seal: (plaintext: string) => string;
  open: (sealed: string) => string;
  sealJson: (value: unknown) => string;
  openJson: <T>(sealed: string | null, fallback: T) => T;
};

export function createSealer(key: Buffer): Sealer {
  const seal = (plaintext: string) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return ["v1", iv, cipher.getAuthTag(), data].map((p) => (typeof p === "string" ? p : p.toString("base64url"))).join(".");
  };

  const open = (sealed: string) => {
    const [version, iv, tag, data] = sealed.split(".");
    if (version !== "v1" || !iv || !tag || data === undefined) throw new Error("Unrecognized secret format");
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
  };

  return {
    seal,
    open,
    sealJson: (value) => seal(JSON.stringify(value)),
    openJson: (sealed, fallback) => (sealed ? JSON.parse(open(sealed)) : fallback),
  };
}
