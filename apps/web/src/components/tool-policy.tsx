/**
 * The one approval control, used by Settings → Approvals and by each connector's tool list:
 * per tool "Just do it / Ask me / Never" next to what the tool does, per source three bulk
 * actions, and the quick-check (reviewer) switch with one plain sentence.
 */
import type { Risk, Settings } from "@z/core";
import { Ban, ChevronDown, Eye, Hand, ListChecks } from "lucide-react";
import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import { keys, queryClient } from "../api/query.ts";
import { useApprovalPolicies, useSaveSetting, useSettings } from "../api/settings.ts";
import { useStable } from "../lib/use-stable.ts";
import { useT } from "../i18n.ts";
import { cn } from "../lib/cn.ts";
import { riskIcon, riskTone } from "../lib/icons.tsx";
import { Button } from "../ui/button.tsx";
import { Menu, MenuItem, MenuSeparator } from "../ui/menu.tsx";
import { Row, RowGroup, SavedMark } from "../ui/row.tsx";
import { Switch } from "../ui/switch.tsx";
import { Segmented } from "../ui/toggle-group.tsx";
import { notify } from "../ui/toast.tsx";

export type Policy = "ask" | "allow" | "deny";

/** Tools that act outside z always ask: only "Never" can be remembered besides "Ask me". */
export const POLICIES: Record<Risk, Policy[]> = { read: ["allow", "ask", "deny"], write: ["allow", "ask", "deny"], external: ["ask", "deny"] };

/** What applies when nothing is stored, or the stored choice no longer fits the tool's risk. */
export function effectivePolicy(risk: Risk, stored: Policy | undefined, declared?: Policy): Policy {
  if (stored && POLICIES[risk].includes(stored)) return stored;
  const fallback = declared ?? (risk === "read" ? "allow" : "ask");
  return POLICIES[risk].includes(fallback) ? fallback : POLICIES[risk][0]!;
}

/** A tool as the control needs it: its policy key (`Settings.approvals`), risk and plugin default. */
export type PolicyTool = { key: string; name: string; risk: Risk; declared?: Policy };

/** Risk as an icon plus a short phrase: "reads", "changes things", "acts outside z". */
export function RiskPhrase({ risk, className }: { risk: Risk; className?: string }) {
  const t = useT();
  const Icon = riskIcon[risk];
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1 text-xs", riskTone[risk], className)}>
      <Icon aria-hidden className="size-3.5" />
      {t[`riskPhrase_${risk}`]}
    </span>
  );
}

/** "Just do it / Ask me / Never" for one tool. */
export function PolicyControl({ name, risk, value, onChange, className }: { name: string; risk: Risk; value: Policy; onChange: (v: Policy) => void; className?: string }) {
  const t = useT();
  return (
    <Segmented<Policy>
      label={t.whenZUses(name)}
      size="sm"
      value={value}
      onChange={onChange}
      className={className}
      options={(
        [
          { value: "allow", label: t.pol_allow_plain },
          { value: "ask", label: t.pol_ask_plain },
          { value: "deny", label: t.pol_deny_plain },
        ] as const
      ).filter((o) => POLICIES[risk].includes(o.value))}
    />
  );
}

const NO_POLICIES: Record<string, Policy> = {};

/**
 * Policy editing for a whole list of tools: the stored choices are read once here (rows get plain
 * values and stay memoised), a change saves at once, optimistically, and `savedKey` names the row
 * that just landed, for its quiet check mark.
 */
export function usePolicyList() {
  const approvals = useApprovalPolicies() ?? NO_POLICIES;
  const { save } = useSaveSetting();
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const setPolicy = useStable((key: string, value: Policy) => {
    const current = queryClient.getQueryData<Settings>(keys.settings);
    if (!current) return;
    save(
      { approvals: { ...current.approvals, [key]: value } },
      {
        onSuccess: () => {
          setSavedKey(key);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => setSavedKey(null), 1500);
        },
      },
    );
  });
  return { approvals, setPolicy, savedKey };
}

/**
 * One tool: what it does (risk phrase), its name and summary, and the control. `badges` and `menu`
 * carry what only some lists have (the connector's "Change what this tool does"). Memoised: lists
 * run to hundreds of rows, and a change re-renders only the row it touches.
 */
export const ToolPolicyRow = memo(function ToolPolicyRow({
  tool,
  policy,
  saved,
  onPolicyChange,
  description,
  code,
  badges,
  menu,
  as: As = "div",
  className,
}: {
  className?: string;
  tool: PolicyTool;
  /** The stored choice for `tool.key`, if any (`usePolicyList().approvals`). */
  policy: Policy | undefined;
  /** Its change just saved. */
  saved: boolean;
  onPolicyChange: (key: string, value: Policy) => void;
  description?: string;
  /** The internal tool name, when the row shows a friendlier title. */
  code?: string;
  badges?: ReactNode;
  menu?: ReactNode;
  as?: "div" | "li";
}) {
  const t = useT();
  const value = effectivePolicy(tool.risk, policy, tool.declared);
  const denied = value === "deny";
  return (
    <As className={cn("flex flex-col gap-2 py-2.5 sm:flex-row sm:items-center sm:gap-4", className)}>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {/* Denied reads as struck through, never dimmed: dimming fails text contrast. */}
          <span className={cn("min-w-0 truncate text-sm font-medium", denied && "line-through decoration-danger decoration-2")} title={tool.name}>
            {tool.name}
          </span>
          <RiskPhrase risk={tool.risk} />
          {code && <code className="min-w-0 truncate font-mono text-xs text-fg-muted">{code}</code>}
          {badges}
        </p>
        {description && (
          <p className="mt-0.5 line-clamp-2 text-xs break-words text-fg-muted sm:truncate" title={description}>
            {description}
          </p>
        )}
        {tool.risk === "external" && <p className="mt-0.5 text-xs text-fg-muted">{t.externalAlwaysAsks}</p>}
      </div>
      <div className="flex items-center gap-1 sm:shrink-0">
        <span className="flex items-center gap-1.5">
          <SavedMark show={saved} iconOnly />
          <PolicyControl name={tool.name} risk={tool.risk} className="w-full sm:w-auto" value={value} onChange={(v) => onPolicyChange(tool.key, v)} />
        </span>
        {menu}
      </div>
    </As>
  );
});

/** "Ask for everything" / "Let read-only tools run" / "Never use this source", for every tool of one source. */
export function BulkPolicyMenu({ source, tools, onMarkAllRead }: { source: string; tools: PolicyTool[]; onMarkAllRead?: () => void }) {
  const t = useT();
  const settings = useSettings();
  const { save } = useSaveSetting();
  const reads = tools.filter((x) => x.risk === "read");
  const apply = (pick: (tool: PolicyTool) => Policy | null) => {
    if (!settings.data) return;
    const next = { ...settings.data.approvals };
    for (const tool of tools) {
      const p = pick(tool);
      if (p && POLICIES[tool.risk].includes(p)) next[tool.key] = p;
    }
    save({ approvals: next });
    notify("success", t.bulkDone(source));
  };
  return (
    <Menu
      align="end"
      trigger={
        <Button size="sm" variant="ghost" aria-label={t.bulkFor(source)} className="normal-case tracking-normal">
          <ListChecks aria-hidden />
          {t.bulkAll}
          <ChevronDown aria-hidden />
        </Button>
      }
    >
      <MenuItem icon={<Hand aria-hidden className="size-4" />} onClick={() => apply(() => "ask")}>
        {t.bulkAskAll}
      </MenuItem>
      {reads.length > 0 ? (
        <MenuItem icon={<Eye aria-hidden className="size-4" />} onClick={() => apply((tool) => (tool.risk === "read" ? "allow" : null))}>
          {t.bulkReadsRun}
        </MenuItem>
      ) : onMarkAllRead ? (
        // A server that gave no hints marks everything as a change; the owner may know better.
        <MenuItem icon={<Eye aria-hidden className="size-4" />} onClick={onMarkAllRead}>
          {t.bulkMarkRead}
        </MenuItem>
      ) : (
        <p className="px-2 py-1.5 text-xs text-fg-muted">{t.bulkNoReads}</p>
      )}
      <MenuSeparator />
      <MenuItem danger icon={<Ban aria-hidden className="size-4" />} onClick={() => apply(() => "deny")}>
        {t.bulkNever}
      </MenuItem>
    </Menu>
  );
}

/** The quick check before acting (the reviewer), with one plain sentence. */
export function QuickCheckRow({ className }: { className?: string }) {
  const t = useT();
  const settings = useSettings();
  const { save, saved } = useSaveSetting();
  if (!settings.data) return null;
  return (
    <RowGroup className={className}>
      <Row label={t.quickCheck} hint={t.quickCheckHint} saved={saved}>
        {({ labelId, hintId }) => (
          <Switch
            aria-labelledby={labelId}
            aria-describedby={hintId}
            checked={settings.data.reviewer === "auto"}
            onCheckedChange={(on) => save({ reviewer: on ? "auto" : "off" })}
          />
        )}
      </Row>
    </RowGroup>
  );
}
