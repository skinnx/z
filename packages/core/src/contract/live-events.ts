import type { Approval } from "./tools.ts";
import type { Task } from "./tasks.ts";
import type { Briefing } from "./briefing.ts";
import type { ChannelView } from "./channels.ts";
import type { Notice } from "./notices.ts";
import type { ConnectorView } from "./connectors.ts";

// ─── Live events (SSE on /api/events) ───────────────────────────────────────

export type LiveEvent =
  | { type: "task"; task: Task }
  | { type: "approval"; approval: Approval }
  | { type: "briefing"; briefing: Briefing }
  | { type: "channel"; channel: ChannelView }
  | { type: "notice"; notice: Notice }
  | { type: "connector"; connector: ConnectorView };

// Routes (HTTP API; overview in ../contract.ts):
// GET    /api/events                       → text/event-stream of LiveEvent
