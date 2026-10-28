import { z } from "zod";

// ─── Skills: reusable instructions the owner invokes with /name ─────────────
// Adapted from CopilotKit/OpenDuet (MIT), `openbot/examples/openduet/skills.yaml`: a skill adds no
// capability. Its `tools` only narrow what a run is offered; the approval policy still decides.

/** The slug typed after `/`. */
export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const MAX_SKILL_INSTRUCTIONS = 8000;

export const SkillInput = z.object({
  name: z.string().regex(SKILL_NAME, "lowercase letters, digits and dashes"),
  description: z.string().trim().min(1).max(200),
  instructions: z.string().trim().min(1).max(MAX_SKILL_INSTRUCTIONS),
  /**
   * Tool names (`web_search`) or globs (`mcp_<connector>_*`, `web_*`). Empty: the run's usual tools.
   * Naming a tool grants nothing: it is intersected with what the approval policy exposes.
   */
  tools: z.array(z.string().regex(/^[A-Za-z0-9_*-]{1,80}$/)).max(64).default([]),
});
export type SkillInput = z.input<typeof SkillInput>;

export type Skill = z.output<typeof SkillInput> & { id: string; createdAt: string; updatedAt: string };

// Routes (HTTP API; overview in ../contract.ts):
// GET    /api/skills                       → Skill[]   (by name)
// POST   /api/skills        SkillInput     → Skill     (409 when the name is taken)
// PUT    /api/skills/:id    SkillInput     → Skill
// DELETE /api/skills/:id                   → { ok: true }
// A chat message or task whose text starts with `/<name>` runs with that skill.

// ─── End skills ─────────────────────────────────────────────────────────────
