/** Owner pairing: a short-lived, single-use code the owner sends to the bot as `/link <code>`. */
import { randomInt } from "node:crypto";

const TTL_MS = 10 * 60 * 1000;
/** Wrong guesses before the active code is voided, so it cannot be brute-forced from a channel. */
const MAX_MISSES = 5;

export type Pairing = ReturnType<typeof createPairing>;

export function createPairing() {
  let active: { code: string; expiresAt: number; misses: number } | null = null;

  return {
    /** A new code replaces any earlier one. */
    issue(): { code: string; expiresAt: string } {
      const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
      active = { code, expiresAt: Date.now() + TTL_MS, misses: 0 };
      return { code, expiresAt: new Date(active.expiresAt).toISOString() };
    },

    /** True once for the right code; any use (right or wrong) counts against it. */
    consume(code: string): boolean {
      if (!active || Date.now() > active.expiresAt) {
        active = null;
        return false;
      }
      if (code === active.code) {
        active = null;
        return true;
      }
      if (++active.misses >= MAX_MISSES) active = null;
      return false;
    },

    /** Drop the active code, e.g. after it was posted somewhere public. */
    revoke(code: string) {
      if (active?.code === code) active = null;
    },
  };
}
