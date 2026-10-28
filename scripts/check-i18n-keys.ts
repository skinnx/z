/**
 * Fails when a string key is defined in more than one `apps/web/src/i18n/<area>.ts`: i18n.ts spreads
 * the areas into one dictionary, so a duplicate would silently override another area's string.
 *
 *   pnpm check:i18n
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(import.meta.dirname, "../apps/web/src/i18n");
const seen = new Map<string, string>();
const dups: string[] = [];
for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts") && f !== "types.ts").sort()) {
  const source = readFileSync(join(dir, file), "utf8");
  const en = /export const en = \{\n([\s\S]*?)\n\} as const;/.exec(source)?.[1];
  if (en === undefined) {
    dups.push(`${file}: no \`export const en = { … } as const;\``);
    continue;
  }
  for (const [, key] of en.matchAll(/^ {2}([A-Za-z_$][\w$]*):/gm)) {
    const where = seen.get(key!);
    if (where) dups.push(`${key} in ${where} and ${file}`);
    else seen.set(key!, file);
  }
}
if (dups.length) {
  console.error(`Duplicate i18n keys:\n  ${dups.join("\n  ")}`);
  process.exit(1);
}
console.log(`i18n: ${seen.size} keys, no duplicates`);
