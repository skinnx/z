import { z } from "zod";

// ─── Shared primitives: model refs, lanes & risk ────────────────────────────
// Used across domains; kept here so contract files never import each other in a cycle.

/** `providerId:modelId`, e.g. `anthropic:claude-opus-5-5` or `local:llama4`. */
export const ModelRef = z.string().regex(/^[a-z0-9-]+:.+$/);
export type ModelRef = z.infer<typeof ModelRef>;

/** Which models serve which job. Each lane is an ordered fallback chain. */
export const Lane = z.enum(["chat", "agent", "briefing", "bot", "fast"]);
export type Lane = z.infer<typeof Lane>;
export const Routing = z.record(Lane, z.array(ModelRef));
export type Routing = z.infer<typeof Routing>;

/**
 * Risk decides the approval policy:
 * - read:     never asks (search, fetch, read inbox)
 * - write:    asks unless the user allows it for that tool
 * - external: always asks (send message, post publicly, pay, delete)
 */
export const Risk = z.enum(["read", "write", "external"]);
export type Risk = z.infer<typeof Risk>;
