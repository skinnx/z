import { z } from "zod";
import type { ServerText } from "./messages.ts";
import type { NoticeQuestion, TaskStatus } from "./tasks.ts";
import type { ApprovalStatus } from "./tools.ts";

// ─── Notices: what z tells its owner, delivered in-app, by Web Push and to the owner channel ─

export type Notice = {
  id: string;
  /** `memory`: z has memories awaiting review (batched, at most one an hour). `question`: a task asks the owner. */
  kind: "approval" | "watch" | "task" | "briefing" | "memory" | "question";
  title: string;
  body: string;
  /** `title` / `body` as message keys the app words in the owner's language; absent for model or plugin text. */
  titleMsg?: ServerText;
  bodyMsg?: ServerText;
  /** App path to open, e.g. `/tasks?id=…`. */
  path: string;
  /** Present for approvals: lets push and channels offer Approve / Deny. */
  approvalId?: string;
  /**
   * With `approvalId`: the approval's status now, so a notice decided elsewhere shows the outcome.
   * Deciding an approval (anywhere) marks its notices read; so do answering a question and resolving a task.
   */
  approvalStatus?: ApprovalStatus;
  /** Present for `question`: simple choices become buttons on push and channels. */
  question?: NoticeQuestion;
  /**
   * Present for `task` notices: how the run ended (`done`, `failed`, `review`, `paused`, `interrupted`),
   * so the app can show the right icon and word the title in the owner's language.
   */
  status?: TaskStatus;
  read: boolean;
  createdAt: string;
};

export const PushSubscriptionInput = z.object({
  endpoint: z.url(),
  keys: z.object({ p256dh: z.string(), auth: z.string() }),
  /** Free text the user recognises, e.g. "Pixel 9 · Chrome". */
  device: z.string().max(80).default(""),
});

// Routes (HTTP API; overview in ../contract.ts):
// GET    /api/notices                      → Notice[]          (newest first, last 100)
// POST   /api/notices/read  { ids?: string[] } → { ok: true }  (all when ids omitted)
// GET    /api/push                         → { publicKey: string, devices: { endpoint, device, createdAt }[] }
// POST   /api/push          PushSubscriptionInput → { ok: true }
// DELETE /api/push          { endpoint }   → { ok: true }
// POST   /api/push/test                    → { sent: number }
// POST   /api/owner/link                   → { code: string, expiresAt: string }  (send `/link <code>` to the bot)
// DELETE /api/owner                        → Settings
