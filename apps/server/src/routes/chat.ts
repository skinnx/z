/** Streaming chat and its stored threads. */
import { ModelRef, NoModelConfiguredError, parseModelRef, streamChat } from "@z/core";
import { safeValidateUIMessages, type UIMessage } from "ai";
import { Hono } from "hono";
import { z } from "zod";
import type { Services } from "../app.ts";
import { badRequest, body, notFound } from "../http.ts";

const ChatBody = z.object({
  id: z.string().min(1).max(128),
  messages: z.array(z.unknown()).min(1),
  model: ModelRef.optional(),
});

function titleOf(messages: UIMessage[]): string {
  const first = messages.find((m) => m.role === "user");
  const text = first?.parts.map((p) => (p.type === "text" ? p.text : "")).join(" ").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 60) : "New chat";
}

export function chatRoutes({ rt }: Services) {
  const { store } = rt;
  const app = new Hono();

  app.post("/chat", async (c) => {
    const input = await body(c, ChatBody);
    const validated = await safeValidateUIMessages({ messages: input.messages });
    if (!validated.success) throw badRequest(`messages: ${validated.error.message}`);
    if (input.model && !store.providers.get(parseModelRef(input.model).providerId)) {
      throw badRequest(`model: unknown provider in "${input.model}"`);
    }

    try {
      return await streamChat(
        {
          messages: validated.data,
          model: input.model,
          signal: c.req.raw.signal,
          onFinish: (messages) => store.threads.save(input.id, titleOf(messages), messages),
        },
        rt.deps("chat"),
      );
    } catch (error) {
      if (error instanceof NoModelConfiguredError) throw badRequest(error.message);
      throw error;
    }
  });

  app.get("/threads", (c) => c.json(store.threads.list()));

  app.get("/threads/:id", (c) => {
    const thread = store.threads.get(c.req.param("id"));
    if (!thread) throw notFound("Thread");
    return c.json(thread);
  });

  app.delete("/threads/:id", (c) => {
    if (!store.threads.delete(c.req.param("id"))) throw notFound("Thread");
    return c.json({ ok: true });
  });

  return app;
}
