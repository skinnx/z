// ─── Context: what the model saw of a chat ──────────────────────────────────

/**
 * Sent as a `data-context` chat part when the prompt was compacted to fit the model's window.
 * The stored conversation is untouched; only what the model saw shrank.
 */
export type ContextReport = {
  /** The oldest turns went to the model as one summary. */
  summarized: boolean;
  /** Old tool results cut to an excerpt. */
  trimmed: number;
  tokensBefore: number;
  tokensAfter: number;
};

// Routes (HTTP API; overview in ../contract.ts):
// POST   /api/chat          { id, messages: UIMessage[], model?: ModelRef }
//                                          → AI SDK UI message stream (useChat compatible)
//                                            A `data-context` part (ContextReport) says when the prompt was compacted.
// GET    /api/threads                      → { id, title, updatedAt }[]
// GET    /api/threads/:id                  → { id, title, messages: UIMessage[] }
// DELETE /api/threads/:id                  → { ok: true }
// DELETE /api/threads                      → { deleted: number }   (all chat threads)
