import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { z } from "zod";

export const badRequest = (message: string) =>
  new HTTPException(400, { res: Response.json({ error: message }, { status: 400 }) });

export const notFound = (what: string) =>
  new HTTPException(404, { res: Response.json({ error: `${what} not found` }, { status: 404 }) });

export async function body<S extends z.ZodType>(c: Context, schema: S): Promise<z.output<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw badRequest("Body must be JSON");
  }
  return validate(schema, raw);
}

export function validate<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path.length ? `${issue.path.join(".")}: ` : "";
    throw badRequest(`${path}${issue?.message ?? "Invalid input"}`);
  }
  return result.data;
}
