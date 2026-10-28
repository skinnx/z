/** Per-tool approval policy, grouped by plugin or connector. Aggregators can list hundreds: search and page. */
import type { Risk } from "@z/core";
import { ChevronDown, Search, ShieldCheck } from "lucide-react";
import { useMemo, useState } from "react";
import { useConnectors } from "../../api/connectors.ts";
import { usePlugins } from "../../api/plugins.ts";
import { LivePolicyControl, type Policy } from "../../components/tool-policy.tsx";
import { useT } from "../../i18n.ts";
import { RiskIcon } from "../../lib/icons.tsx";
import { Button } from "../../ui/button.tsx";
import { Empty, Loading, LoadError } from "../../ui/card.tsx";
import { Input } from "../../ui/field.tsx";
import { useSaveSetting, useSettings } from "../../api/settings.ts";
import { Row, RowGroup } from "../../ui/row.tsx";
import { Switch } from "../../ui/switch.tsx";

type Tool = { key: string; name: string; description: string; risk: Risk; declared?: Policy };
type Group = { id: string; label: string; tools: Tool[] };

const PAGE = 25;

export function ApprovalsPanel() {
  const t = useT();
  const plugins = usePlugins();
  const connectors = useConnectors();
  const [query, setQuery] = useState("");

  const groups = useMemo<Group[]>(
    () => [
      ...(plugins.data ?? [])
        .filter((p) => p.tools.length > 0)
        .map((p) => ({
          id: `plugin:${p.id}`,
          label: p.name,
          tools: p.tools.map((tool) => ({ key: `${p.id}_${tool.name}`, name: tool.name, description: tool.description, risk: tool.risk, declared: tool.defaultPolicy })),
        })),
      ...(connectors.data ?? [])
        .filter((c) => c.tools.length > 0)
        .map((c) => ({
          id: `connector:${c.id}`,
          label: c.label,
          tools: c.tools.map((tool) => ({ key: tool.toolName, name: tool.title || tool.name, description: tool.description, risk: tool.risk })),
        })),
    ],
    [plugins.data, connectors.data],
  );

  const q = query.trim().toLowerCase();
  const filtered = q
    ? groups
        .map((g) => ({ ...g, tools: g.label.toLowerCase().includes(q) ? g.tools : g.tools.filter((x) => `${x.name} ${x.key} ${x.description}`.toLowerCase().includes(q)) }))
        .filter((g) => g.tools.length > 0)
    : groups;
  const total = groups.reduce((n, g) => n + g.tools.length, 0);
  const matched = filtered.reduce((n, g) => n + g.tools.length, 0);

  if (plugins.isPending || connectors.isPending) return <Loading label={t.loading} className="h-32" />;
  const failed = (plugins.error && !plugins.data && plugins) || (connectors.error && !connectors.data && connectors);
  if (failed) return <LoadError error={failed.error} onRetry={() => void failed.refetch()} />;
  if (total === 0) return <Empty icon={<ShieldCheck />} text={t.noTools} className="mt-4" />;

  return (
    <div className="flex flex-col gap-1">
      <ReviewerRow />
      <p className="pt-3 text-xs text-fg-muted">{t.approvalsHint}</p>
      <div className="sticky top-0 z-10 -mx-5 flex items-center gap-3 bg-surface px-5 py-3">
        <div className="relative min-w-0 flex-1">
          <Search aria-hidden className="pointer-events-none absolute start-3 top-3 size-4 text-fg-muted" />
          <Input type="search" aria-label={t.searchAllTools} placeholder={t.searchAllTools} value={query} onValueChange={setQuery} className="ps-9" />
        </div>
        <span aria-live="polite" className="shrink-0 text-xs text-fg-muted tabular-nums">
          {q ? t.toolsMatching(matched, total) : t.toolCount(total)}
        </span>
      </div>
      {filtered.length === 0 ? (
        <div className="flex items-center gap-3 py-4 text-sm text-fg-muted">
          {t.noToolMatch}
          <Button size="sm" variant="ghost" onClick={() => setQuery("")}>
            {t.clearSearch}
          </Button>
        </div>
      ) : (
        // Keyed on the query so paging restarts with each search.
        filtered.map((g) => <ToolGroup key={`${g.id}|${q}`} group={g} />)
      )}
    </div>
  );
}

/** The action reviewer: off, every change set to Ask asks; auto, what the owner explicitly asked for runs. */
function ReviewerRow() {
  const t = useT();
  const settings = useSettings();
  const { save, saved } = useSaveSetting();
  if (!settings.data) return null;
  return (
    <RowGroup>
      <Row label={t.reviewer} hint={t.reviewerHint} saved={saved}>
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

function ToolGroup({ group }: { group: Group }) {
  const t = useT();
  const [limit, setLimit] = useState(PAGE);
  const shown = group.tools.slice(0, limit);
  const left = group.tools.length - shown.length;
  return (
    <RowGroup
      label={
        <span className="flex items-center gap-2">
          {group.label}
          <span className="font-normal tabular-nums normal-case">{t.toolCount(group.tools.length)}</span>
        </span>
      }
    >
      {shown.map((tool) => (
        <div key={tool.key} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5">
          <RiskIcon risk={tool.risk} t={t} />
          <div className="min-w-0 flex-1 basis-32">
            <p className="truncate font-mono text-sm" title={tool.name}>
              {tool.name}
            </p>
            {tool.description && (
              <p className="line-clamp-2 text-xs text-fg-muted sm:truncate" title={tool.description}>
                {tool.description}
              </p>
            )}
          </div>
          {/* Phones: the control takes its own line, so the name and description keep the width. */}
          <div className="max-sm:w-full max-sm:ps-7">
            <LivePolicyControl toolKey={tool.key} risk={tool.risk} declared={tool.declared} showSaved className="w-full sm:w-44" />
          </div>
        </div>
      ))}
      {left > 0 && (
        <div className="py-1.5">
          <Button size="sm" variant="ghost" onClick={() => setLimit((n) => n + PAGE)}>
            <ChevronDown aria-hidden />
            {t.showMore(Math.min(PAGE, left), left)}
          </Button>
        </div>
      )}
    </RowGroup>
  );
}
