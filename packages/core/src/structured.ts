/**
 * Structured output via the AI SDK's `Output.object`, tolerant of providers that
 * only do JSON mode and wrap the object in prose or code fences.
 */
import { generateText, NoObjectGeneratedError, Output } from "ai";
import type { z } from "zod";

type Args = Omit<Parameters<typeof generateText>[0], "output" | "tools" | "toolApproval">;

/** Null when the model's reply holds no object matching `schema` (logged with `log`). */
export async function generateStructured<S extends z.ZodType>(
  schema: S,
  args: Args,
  log?: (text: string) => void,
): Promise<z.output<S> | null> {
  try {
    const result = await generateText({ ...args, output: Output.object({ schema }) } as Parameters<typeof generateText>[0]);
    return result.output as z.output<S>;
  } catch (error) {
    if (!NoObjectGeneratedError.isInstance(error)) throw error;
    const parsed = parseLenient(schema, error.text ?? "");
    if (!parsed) log?.(`structured output did not parse: ${(error.text ?? "").slice(0, 300)}`);
    return parsed;
  }
}

/** The first `{…}` in `text` that parses and matches `schema`. */
export function parseLenient<S extends z.ZodType>(schema: S, text: string): z.output<S> | null {
  const unfenced = text.replace(/```(?:json)?/gi, "");
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const result = schema.safeParse(JSON.parse(unfenced.slice(start, end + 1)));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
