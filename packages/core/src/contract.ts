/**
 * The shared contract between core, server, adapters and web.
 * Everything that crosses a process or package boundary is defined in `./contract/<domain>.ts`
 * and re-exported here; import from this file (or `@z/core`), never from a domain file directly.
 */
export * from "./contract/common.ts";
export * from "./contract/providers.ts";
export * from "./contract/context.ts";
export * from "./contract/tools.ts";
export * from "./contract/tasks.ts";
export * from "./contract/delivery.ts";
export * from "./contract/briefing.ts";
export * from "./contract/settings.ts";
export * from "./contract/channels.ts";
export * from "./contract/plugins.ts";
export * from "./contract/memory.ts";
export * from "./contract/notices.ts";
export * from "./contract/connectors.ts";
export * from "./contract/logins.ts";
export * from "./contract/setup.ts";
export * from "./contract/skills.ts";
export * from "./contract/live-events.ts";
export * from "./contract/messages.ts";

// ─── HTTP API ───────────────────────────────────────────────────────────────
// All JSON. Errors: `{ error: string, errorMsg?: ServerText }` with a 4xx/5xx status (errorMsg: see contract/messages.ts).
// Each route group is listed next to its types, under "Routes" in the domain file:
//
// /api/settings                        contract/settings.ts
// /api/providers, /api/routing         contract/providers.ts
// /api/chat, /api/threads              contract/context.ts
// /api/tasks                           contract/tasks.ts
// /api/approvals                       contract/tools.ts
// /api/briefing                        contract/briefing.ts
// /api/adapters, /api/plugins          contract/plugins.ts
// /api/channels, /hooks/:channelId     contract/channels.ts
// /api/memories                        contract/memory.ts
// /api/notices, /api/push, /api/owner  contract/notices.ts
// /api/connector-presets, /api/connectors, /oauth/callback   contract/connectors.ts
// /api/logins                          contract/logins.ts
// /api/setup, /api/diagnostics         contract/setup.ts
// /api/skills                          contract/skills.ts
// /api/events                          contract/live-events.ts
//
// GET    /api/health                       → { ok: true, version }
// GET    /api/export                       → JSON attachment `z-export-<date>.json`: everything except secrets
//                                            (settings, routing, provider/channel/connector views, tasks, approvals,
//                                            briefings, memories, skills, threads, notices)
//
// Auth: when Z_TOKEN is set, every /api route requires `Authorization: Bearer <Z_TOKEN>`
// (or `?token=` for EventSource). /hooks routes are verified by each adapter.

export const API_PREFIX = "/api";
