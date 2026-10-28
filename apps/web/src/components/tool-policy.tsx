import type { Risk } from "@z/core";
import { useSaveSetting, useSettings } from "../api/settings.ts";
import { useT } from "../i18n.ts";
import { SavedMark } from "../ui/row.tsx";
import { Segmented } from "../ui/toggle-group.tsx";

export type Policy = "ask" | "allow" | "deny";

/** Read tools never ask; external tools always ask (only a deny can be remembered). */
export const POLICIES: Record<Risk, Policy[]> = { read: ["allow", "deny"], write: ["ask", "allow", "deny"], external: ["ask", "deny"] };

/** What applies when nothing is stored, or the stored choice no longer fits the tool's risk. */
export function effectivePolicy(risk: Risk, stored: Policy | undefined, declared?: Policy): Policy {
  if (stored && POLICIES[risk].includes(stored)) return stored;
  const fallback = declared ?? (risk === "read" ? "allow" : "ask");
  return POLICIES[risk].includes(fallback) ? fallback : POLICIES[risk][0]!;
}

/** The ask / allow / deny control for one tool, keyed like `Settings.approvals`. */
export function PolicyControl({ toolKey, risk, value, onChange, className }: { toolKey: string; risk: Risk; value: Policy; onChange: (v: Policy) => void; className?: string }) {
  const t = useT();
  return (
    <Segmented<Policy>
      label={`${t.approvalPolicy}: ${toolKey}`}
      size="sm"
      value={value}
      onChange={onChange}
      className={className}
      options={(
        [
          { value: "ask", label: t.pol_ask },
          { value: "allow", label: t.pol_allow },
          { value: "deny", label: t.pol_deny },
        ] as const
      ).filter((o) => POLICIES[risk].includes(o.value))}
    />
  );
}

/** A policy control that saves right away, optimistically, with a quiet check once it lands. */
export function LivePolicyControl({ toolKey, risk, declared, showSaved, className }: { toolKey: string; risk: Risk; declared?: Policy; showSaved?: boolean; className?: string }) {
  const settings = useSettings();
  const { save, saved } = useSaveSetting();
  const approvals = settings.data?.approvals ?? {};
  const control = (
    <PolicyControl
      toolKey={toolKey}
      risk={risk}
      className={className}
      value={effectivePolicy(risk, approvals[toolKey], declared)}
      onChange={(v) => settings.data && save({ approvals: { ...approvals, [toolKey]: v } })}
    />
  );
  if (!showSaved) return control;
  return (
    <span className="flex items-center gap-1.5">
      <SavedMark show={saved} iconOnly />
      {control}
    </span>
  );
}
