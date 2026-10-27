/**
 * Web Push with node:crypto only: VAPID (RFC 8292) and aes128gcm payload encryption (RFC 8291 / RFC 8188).
 * Zero dependencies on purpose: the protocol is ~100 lines, and the usual package drags in its own
 * JWT, ASN.1 and proxy-agent stacks for what node:crypto already does.
 */
import { createCipheriv, createECDH, createPrivateKey, generateKeyPairSync, hkdfSync, randomBytes, sign, type webcrypto } from "node:crypto";

export type VapidKeys = { publicJwk: webcrypto.JsonWebKey; privateJwk: webcrypto.JsonWebKey };
export type PushTarget = { endpoint: string; keys: { p256dh: string; auth: string } };

const b64url = (data: Buffer | string) => Buffer.from(data).toString("base64url");

export function generateVapidKeys(): VapidKeys {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return { publicJwk: publicKey.export({ format: "jwk" }), privateJwk: privateKey.export({ format: "jwk" }) };
}

/** Uncompressed P-256 point, base64url: the `applicationServerKey` browsers subscribe with. */
export function vapidPublicKey(keys: VapidKeys): string {
  const { x, y } = keys.publicJwk;
  return b64url(Buffer.concat([Buffer.from([4]), Buffer.from(x!, "base64url"), Buffer.from(y!, "base64url")]));
}

/** `Authorization: vapid t=<ES256 JWT>, k=<public key>` for one push service origin. */
export function vapidAuthorization(keys: VapidKeys, endpoint: string, subject: string, now = Date.now()): string {
  const header = b64url(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const claims = b64url(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject }));
  const key = createPrivateKey({ key: keys.privateJwk, format: "jwk" });
  const signature = sign("sha256", Buffer.from(`${header}.${claims}`), { key, dsaEncoding: "ieee-p1363" });
  return `vapid t=${header}.${claims}.${b64url(signature)}, k=${vapidPublicKey(keys)}`;
}

/** RFC 8291: one aes128gcm record keyed from an ephemeral ECDH share and the subscription's auth secret. */
export function encryptPayload(target: PushTarget, plaintext: Buffer): Buffer {
  const uaPublic = Buffer.from(target.keys.p256dh, "base64url");
  const authSecret = Buffer.from(target.keys.auth, "base64url");
  const ecdh = createECDH("prime256v1");
  const asPublic = ecdh.generateKeys();
  const shared = ecdh.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", shared, authSecret, keyInfo, 32));
  const salt = randomBytes(16);
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  // 0x02 marks the last (and only) record; no padding.
  const body = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const recordSize = Buffer.alloc(4);
  recordSize.writeUInt32BE(4096);
  return Buffer.concat([salt, recordSize, Buffer.from([asPublic.length]), asPublic, body]);
}

/** The HTTP request a push service expects for one encrypted message. */
export function buildPushRequest(
  target: PushTarget,
  payload: unknown,
  vapid: { keys: VapidKeys; subject: string },
  opts: { ttl?: number; urgency?: "low" | "normal" | "high" } = {},
): { url: string; init: RequestInit & { body: Buffer } } {
  return {
    url: target.endpoint,
    init: {
      method: "POST",
      headers: {
        authorization: vapidAuthorization(vapid.keys, target.endpoint, vapid.subject),
        "content-encoding": "aes128gcm",
        "content-type": "application/octet-stream",
        ttl: String(opts.ttl ?? 24 * 3600),
        urgency: opts.urgency ?? "normal",
      },
      body: encryptPayload(target, Buffer.from(JSON.stringify(payload))),
    },
  };
}
