/**
 * Highly sensitive data z refuses to hand to tools that write or send:
 * payment cards, IBANs, private keys and common API key formats.
 */

/** What was found, phrased for "blocked: contains …". */
export type SensitiveKind = "a card number" | "an IBAN" | "a private key" | "an API key" | "data nested too deeply to check";

/** How deep the guard reads a tool input; anything nested deeper is blocked rather than skipped. */
const MAX_DEPTH = 20;
const TOO_DEEP = Symbol("too deep");

const CARD = /(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d-])/g;
/** Issuer prefixes (Visa, Mastercard, Amex, Discover, JCB, Diners, UnionPay, Maestro). Keeps timestamps and ids out. */
const CARD_PREFIX = /^(4|5[1-5]|2[2-7]|3[47]|3[05689]|6[0-9]|50|5[6-9])/;
const IBAN = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}\b/g;
const PRIVATE_KEY = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/;
const API_KEYS = [
  /\bsk-(?:[A-Za-z0-9]+-)*[A-Za-z0-9_-]{20,}/, // OpenAI, Anthropic (sk-ant-…), DeepSeek, …
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{40,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
];

export function luhnValid(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

function ibanValid(raw: string): boolean {
  const iban = raw.replace(/ /g, "");
  if (iban.length < 15 || iban.length > 34) return false;
  const moved = iban.slice(4) + iban.slice(0, 4);
  let rest = 0;
  for (const ch of moved) {
    const n = ch >= "A" ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of n) rest = (rest * 10 + Number(d)) % 97;
  }
  return rest === 1;
}

/** Every string (and number) inside a tool input, keys included. Throws `TOO_DEEP` past `MAX_DEPTH`. */
function strings(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > MAX_DEPTH && value !== null && typeof value === "object") throw TOO_DEEP;
  if (typeof value === "string") out.push(value);
  else if (typeof value === "number" || typeof value === "bigint") out.push(String(value));
  else if (Array.isArray(value)) for (const v of value) strings(v, out, depth + 1);
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      strings(v, out, depth + 1);
    }
  }
  return out;
}

/** The first kind of sensitive data found in `value`, or null. */
export function findSensitive(value: unknown): SensitiveKind | null {
  let text: string;
  try {
    text = strings(value).join("\n");
  } catch (error) {
    if (error === TOO_DEEP) return "data nested too deeply to check";
    throw error;
  }
  if (PRIVATE_KEY.test(text)) return "a private key";
  for (const m of text.matchAll(CARD)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length >= 13 && digits.length <= 19 && CARD_PREFIX.test(digits) && luhnValid(digits)) return "a card number";
  }
  for (const m of text.matchAll(IBAN)) {
    // The match can run into following words ("… 00 THANKS"): try shorter group prefixes too.
    const groups = m[0].split(" ");
    for (let n = groups.length; n > 0; n--) if (ibanValid(groups.slice(0, n).join(""))) return "an IBAN";
  }
  if (API_KEYS.some((re) => re.test(text))) return "an API key";
  return null;
}
