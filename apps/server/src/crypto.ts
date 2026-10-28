/** AES-256-GCM for secrets at rest. Format: `v1.<iv>.<tag>.<ciphertext>` (base64url). */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { registerSecret, registerSecretsIn } from "./secrets.ts";

export type Sealer = {
  seal: (plaintext: string) => string;
  open: (sealed: string) => string;
  sealJson: (value: unknown) => string;
  openJson: <T>(sealed: string | null, fallback: T) => T;
};

/**
 * Every value that is sealed or opened is a secret by definition, so each one is registered with
 * the secret registry on its way in and out, and log output redacts it from then on.
 */
export function createSealer(key: Buffer): Sealer {
  const encrypt = (plaintext: string) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return ["v1", iv, cipher.getAuthTag(), data].map((p) => (typeof p === "string" ? p : p.toString("base64url"))).join(".");
  };

  const decrypt = (sealed: string) => {
    const [version, iv, tag, data] = sealed.split(".");
    if (version !== "v1" || !iv || !tag || data === undefined) throw new Error("Unrecognized secret format");
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
  };

  return {
    seal: (plaintext) => (registerSecret(plaintext), encrypt(plaintext)),
    open: (sealed) => {
      const plaintext = decrypt(sealed);
      registerSecret(plaintext);
      return plaintext;
    },
    sealJson: (value) => (registerSecretsIn(value), encrypt(JSON.stringify(value))),
    openJson: (sealed, fallback) => {
      if (!sealed) return fallback;
      const value = JSON.parse(decrypt(sealed));
      registerSecretsIn(value);
      return value;
    },
  };
}
