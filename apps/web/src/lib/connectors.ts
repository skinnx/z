import type { ConnectorAuth, ConnectorPreset, ConnectorView } from "@z/core";
import { KeyRound, LockKeyholeOpen, LogIn, type LucideIcon } from "lucide-react";

export const CATEGORIES = ["docs", "dev", "work", "aggregator"] as const satisfies readonly ConnectorPreset["category"][];

export const authIcon: Record<ConnectorAuth, LucideIcon> = { none: LockKeyholeOpen, headers: KeyRound, oauth: LogIn };

const PLACEHOLDER = /\{([^{}]+)\}/g;

/** `https://gitmcp.io/{owner}/{repo}` → text and placeholder parts, in order. */
export function templateParts(url: string): ({ text: string } | { name: string })[] {
  const parts: ({ text: string } | { name: string })[] = [];
  let last = 0;
  for (const m of url.matchAll(PLACEHOLDER)) {
    if (m.index > last) parts.push({ text: url.slice(last, m.index) });
    parts.push({ name: m[1]! });
    last = m.index + m[0].length;
  }
  if (last < url.length) parts.push({ text: url.slice(last) });
  return parts;
}

export function placeholders(url: string): string[] {
  return [...url.matchAll(PLACEHOLDER)].map((m) => m[1]!);
}

export function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(PLACEHOLDER, (_, name: string) => encodeURIComponent(values[name]?.trim() ?? ""));
}

/** Placeholders that carry a secret are typed like passwords and kept out of labels. */
export const isSecretName = (name: string) => /key|secret|token|password/i.test(name);

/** `https://mcp.deepwiki.com/mcp` → `mcp.deepwiki.com`; templates and `…` displays included. */
export function urlHost(url: string): string {
  try {
    return new URL(url.replace(PLACEHOLDER, "x").replace("…", "")).host;
  } catch {
    return url.replace(/^\w+:\/\//, "").split(/[/?#]/)[0] ?? url;
  }
}

/** Best guess at which preset a saved connector came from (the view keeps no preset id). */
export function presetOf(c: ConnectorView, presets: ConnectorPreset[]): ConnectorPreset | undefined {
  const host = urlHost(c.urlDisplay);
  const sameHost = presets.filter((p) => urlHost(p.url) === host);
  return sameHost.find((p) => p.auth === c.auth) ?? sameHost[0];
}

/** Value for the preset's header, e.g. `Bearer {token}` with the typed token. */
export function headerValue(template: string, secret: string): string {
  return /\{[^{}]+\}/.test(template) ? template.replace(PLACEHOLDER, secret) : secret;
}

export function uniqueId(base: string, taken: string[]): string {
  const root = base || "connector";
  if (!taken.includes(root)) return root;
  for (let i = 2; ; i++) {
    const next = `${root.slice(0, 29)}-${i}`;
    if (!taken.includes(next)) return next;
  }
}
