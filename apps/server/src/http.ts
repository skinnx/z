import { english, say, type ServerText } from "@z/core";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { z } from "zod";

/** An error body: the English `error` for API clients, plus `errorMsg` for the app to word (contract/messages.ts). */
export const errorBody = (error: string | ServerText) =>
  typeof error === "string" ? { error } : { error: english(error), errorMsg: error };

/** An error response with that body. */
export const errorResponse = (error: string | ServerText, status: number) => Response.json(errorBody(error), { status });

/** A plain string is a validation detail: it stays English and the app adds a translated prefix. */
export const badRequest = (message: string | ServerText) =>
  new HTTPException(400, { res: errorResponse(typeof message === "string" ? say("errInvalid", { detail: message }) : message, 400) });

const THINGS = {
  Channel: "thingChannel",
  Thread: "thingThread",
  Provider: "thingProvider",
  Plugin: "thingPlugin",
  Connector: "thingConnector",
  "Sign-in": "thingLogin",
  Memory: "thingMemory",
  Skill: "thingSkill",
  Task: "thingTask",
  Approval: "thingApproval",
} as const;

export const notFound = (what: keyof typeof THINGS | (string & {})) => {
  const thing = THINGS[what as keyof typeof THINGS];
  return new HTTPException(404, { res: errorResponse(say("errNotFound", { what: thing ? say(thing) : what }), 404) });
};

export async function body<S extends z.ZodType>(c: Context, schema: S): Promise<z.output<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw badRequest(say("errBodyJson"));
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
