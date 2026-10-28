import type { Risk, Settings } from "@z/core";
import { useMutation } from "@tanstack/react-query";
import { api } from "../api/client.ts";
import { keys, queryClient } from "../api/query.ts";
import { useSettings } from "../api/settings.ts";
import { useT } from "../i18n.ts";
import { notifyError } from "../ui/toast.tsx";
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

/** A policy control that saves right away (outside the Settings form), optimistically. */
export function LivePolicyControl({ toolKey, risk, className }: { toolKey: string; risk: Risk; className?: string }) {
  const settings = useSettings();
  const save = useMutation({
    mutationFn: (approvals: Settings["approvals"]) => api<Settings>("/settings", { method: "PUT", body: { approvals } }),
    onMutate: async (approvals) => {
      await queryClient.cancelQueries({ queryKey: keys.settings });
      const previous = queryClient.getQueryData<Settings>(keys.settings);
      if (previous) queryClient.setQueryData<Settings>(keys.settings, { ...previous, approvals });
      return { previous };
    },
    onError: (e, _v, ctx) => {
      queryClient.setQueryData(keys.settings, ctx?.previous);
      notifyError(e);
    },
    onSuccess: (data) => queryClient.setQueryData(keys.settings, data),
  });
  const approvals = settings.data?.approvals ?? {};
  return (
    <PolicyControl
      toolKey={toolKey}
      risk={risk}
      className={className}
      value={effectivePolicy(risk, approvals[toolKey])}
      onChange={(v) => settings.data && save.mutate({ ...approvals, [toolKey]: v })}
    />
  );
}
