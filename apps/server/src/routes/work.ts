/** Tasks, approvals and the briefing. */
import { ApprovalDecision, describeError, TaskInput } from "@z/core";
import { Hono } from "hono";
import { z } from "zod";
import type { Services } from "../app.ts";
import { badRequest, body, notFound, validate } from "../http.ts";
import { isValidCron } from "../schedule.ts";

const ApprovalStatusQuery = z.enum(["pending", "approved", "denied", "expired"]).optional();

export function workRoutes({ rt, tasks, briefings }: Services) {
  const { store } = rt;
  const app = new Hono();

  const found = <T>(value: T | null, what: string): T => {
    if (value === null) throw notFound(what);
    return value;
  };

  app.get("/tasks", (c) => c.json(store.tasks.list()));

  app.post("/tasks", async (c) => {
    const input = await body(c, TaskInput);
    if (input.schedule && !isValidCron(input.schedule, store.settings.get().timezone)) {
      throw badRequest("schedule: invalid cron expression");
    }
    return c.json(tasks.create(input), 201);
  });

  app.post("/tasks/:id/run", (c) => c.json(found(tasks.runNow(c.req.param("id")), "Task")));
  app.post("/tasks/:id/cancel", (c) => c.json(found(tasks.cancel(c.req.param("id")), "Task")));

  app.delete("/tasks/:id", (c) => {
    if (!tasks.delete(c.req.param("id"))) throw notFound("Task");
    return c.json({ ok: true });
  });

  app.get("/approvals", (c) => c.json(store.approvals.list(validate(ApprovalStatusQuery, c.req.query("status")))));

  app.post("/approvals/:id", async (c) => {
    const decision = await body(c, ApprovalDecision);
    return c.json(found(tasks.decide(c.req.param("id"), decision), "Approval"));
  });

  app.get("/briefing", (c) => c.json(store.briefings.latest()));

  app.post("/briefing", async (c) => {
    try {
      return c.json(await briefings.generate());
    } catch (error) {
      return c.json({ error: `Briefing failed: ${describeError(error)}` }, 500);
    }
  });

  return app;
}
