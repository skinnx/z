/**
 * Structured output via the AI SDK's `Output.object`, tolerant of providers that
 * only do JSON mode and wrap the object in prose or code fences.
 */
import { APICallError, generateText, NoObjectGeneratedError, Output } from "ai";
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
    let text: string;
    if (NoObjectGeneratedError.isInstance(error)) text = error.text ?? "";
    // Some models refuse JSON mode outright: ask again as plain text (the prompt describes the shape).
    else if (APICallError.isInstance(error) && error.statusCode === 400 && /json|response.?format|structured/i.test(error.message)) {
      log?.(`JSON mode unsupported, retrying as text: ${error.message.slice(0, 120)}`);
      text = (await generateText(args as Parameters<typeof generateText>[0])).text;
    } else throw error;
    const parsed = parseLenient(schema, text);
    if (!parsed) log?.(`structured output did not parse: ${text.slice(0, 300)}`);
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
