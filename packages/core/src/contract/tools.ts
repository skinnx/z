import { z } from "zod";
import type { Risk } from "./common.ts";

// ─── Tools, risk & approvals ────────────────────────────────────────────────


export const ApprovalPolicy = z.record(z.string(), z.enum(["ask", "allow", "deny"]));
export type ApprovalPolicy = z.infer<typeof ApprovalPolicy>;

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";

// ─── Approvals: preview, safety floor & action reviewer ─────────────────────
// Every non-read call passes, in order: the safety floor (credentials, security settings,
// payments, account deletion always ask the person, whatever the policy), the per-tool policy,
// then for `write` tools the action reviewer (`fast` lane), which may only let through what the
// owner explicitly asked for and fails closed. `external` tools always ask.

/**
 * Exactly what an approval acts on, nothing cut. `fields` lead with recipients, subject and body
 * when the call sends something; `fullText` is the whole preview as plain text. Push and channel
 * messages carry Approve buttons only when all of `fullText` fits; otherwise "Open to review".
 */
export type ApprovalPreview = {
  kind: "send" | "change" | "generic";
  fields: { label: string; value: string }[];
  fullText: string;
};

/** `auto`: the reviewer may run `write` tools set to Ask when the owner explicitly asked for that exact action. */
export const ReviewerMode = z.enum(["off", "auto"]);
export type ReviewerMode = z.infer<typeof ReviewerMode>;

// ─── End approvals ──────────────────────────────────────────────────────────

export type Approval = {
  id: string;
  taskId: string;
  /** AI SDK tool approval id, used to resume the loop. */
  toolApprovalId: string;
  tool: string;
  risk: Risk;
  input: unknown;
  /** One-line, human readable description of what will happen. */
  summary: string;
  /** The full preview the person approves (see ApprovalPreview). */
  preview: ApprovalPreview;
  /** Why it asks, completing "Asking because …" (safety floor or reviewer); null for a plain policy ask. */
  reason: string | null;
  status: ApprovalStatus;
  createdAt: string;
  decidedAt: string | null;
};

export const ApprovalDecision = z.object({
  approve: z.boolean(),
  /** Remember the choice for this tool from now on. */
  remember: z.boolean().default(false),
  note: z.string().max(500).optional(),
});
export type ApprovalDecision = z.input<typeof ApprovalDecision>;

// Routes (HTTP API; overview in ../contract.ts):
// GET    /api/approvals?status=pending     → Approval[]
// POST   /api/approvals/:id ApprovalDecision → Approval
