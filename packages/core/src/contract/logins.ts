import { z } from "zod";

// ─── Saved sign-ins: logins the browser fills itself, so the model never sees a password ─
// (Idea from CopilotKit OpenDuet's password vault, MIT; re-implemented for z.)

/** `https://host[:port]`, exactly; plain http only for localhost. */
export const LoginOrigin = z
  .string()
  .trim()
  .refine((raw) => {
    try {
      const url = new URL(raw);
      const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      return url.origin === raw.replace(/\/$/, "").toLowerCase() && (url.protocol === "https:" || (url.protocol === "http:" && local));
    } catch {
      return false;
    }
  }, "must be an origin like https://example.com (plain http only for localhost)")
  .transform((raw) => new URL(raw).origin);

/** Base32 TOTP secret as sites show it under "can't scan the code?"; spaces are ignored. */
const TotpSecret = z
  .string()
  .transform((s) => s.replace(/[\s-]/g, "").toUpperCase())
  .refine((s) => s === "" || /^[A-Z2-7]{16,}=*$/.test(s), "must be a base32 secret (letters A–Z and digits 2–7)");

/** One login per origin. Everything but the origin is sealed at rest and write-only over the API. */
export const LoginInput = z.object({
  origin: LoginOrigin,
  username: z.string().trim().min(1).max(256),
  password: z.string().min(1).max(1024),
  /** For sites that ask for a 6-digit authenticator code after the password. */
  totpSecret: TotpSecret.optional(),
});
export type LoginInput = z.input<typeof LoginInput>;

/** Omit `password` or `totpSecret` to keep the stored one; an empty `totpSecret` removes it. */
export const LoginUpdate = LoginInput.extend({ password: LoginInput.shape.password.optional() });
export type LoginUpdate = z.input<typeof LoginUpdate>;

export type LoginView = {
  id: string;
  origin: string;
  username: string;
  hasTotp: boolean;
  updatedAt: string;
  /** When the browser last filled it. */
  lastUsedAt: string | null;
};

// ─── End saved sign-ins ─────────────────────────────────────────────────────

// Routes (HTTP API; overview in ../contract.ts):
// GET    /api/logins                       → LoginView[]      (saved sign-ins; passwords and TOTP secrets never leave)
// POST   /api/logins        LoginInput     → LoginView        (409 when the origin already has one)
// PUT    /api/logins/:id    LoginUpdate    → LoginView
// DELETE /api/logins/:id                   → { ok: true }
