/** Connected MCP sources at a glance: status, on/off, and the way to the full Sources screen. */
import type { ConnectorView } from "@z/core";
import { Cable, Plus } from "lucide-react";
import { connectorInput, useConnectors, useSaveConnector } from "../../api/connectors.ts";
import { useT } from "../../i18n.ts";
import { cn } from "../../lib/cn.ts";
import { statusDot } from "../../lib/connectors.ts";
import { Button } from "../../ui/button.tsx";
import { Empty, Loading, LoadError } from "../../ui/card.tsx";
import { Row, RowGroup } from "../../ui/row.tsx";
import { Switch } from "../../ui/switch.tsx";
import { notifyError } from "../../ui/toast.tsx";
import { useSettingsRoute } from "../route.ts";

export function SourcesPanel() {
  const t = useT();
  const route = useSettingsRoute();
  const connectors = useConnectors();
  const list = connectors.data ?? [];

  const connect = (
    <Button size="sm" variant={list.length ? "secondary" : "primary"} onClick={() => route.leave("/connect")}>
      <Plus aria-hidden />
      {t.connectSource}
    </Button>
  );

  if (connectors.isPending) return <Loading label={t.loading} className="h-32" />;
  if (connectors.error && !connectors.data)
    return <LoadError error={connectors.error} onRetry={() => void connectors.refetch()} retryLabel={t.retry} />;
  if (list.length === 0)
    return (
      <Empty icon={<Cable />} text={t.sourcesEmpty} className="mt-4">
        {connect}
      </Empty>
    );

  return (
    <>
      <RowGroup>
        {list.map((c) => (
          <SourceRow key={c.id} connector={c} onManage={() => route.leave(`/connect?open=${encodeURIComponent(c.id)}`)} />
        ))}
      </RowGroup>
      <div className="border-t border-line py-3">{connect}</div>
    </>
  );
}

function SourceRow({ connector: c, onManage }: { connector: ConnectorView; onManage: () => void }) {
  const t = useT();
  const save = useSaveConnector();
  return (
    <Row
      label={
        <span className="flex items-center gap-2">
          <span aria-hidden className={cn("size-2 shrink-0 rounded-full", statusDot[c.status])} />
          {c.label}
        </span>
      }
      hint={
        <>
          {t[`cst_${c.status}`]}
          {c.tools.length > 0 && ` · ${t.toolCount(c.tools.length)}`}
        </>
      }
    >
      {({ labelId, hintId }) => (
        <>
          <Button size="sm" aria-describedby={labelId} onClick={onManage}>
            {t.manage}
          </Button>
          <Switch
            aria-labelledby={labelId}
            aria-describedby={hintId}
            // Optimistic: connecting can take seconds; a failure falls back to the stored value.
            checked={save.isPending ? (save.variables.enabled ?? c.enabled) : c.enabled}
            disabled={save.isPending}
            onCheckedChange={(enabled) => save.mutate(connectorInput(c, { enabled }), { onError: notifyError })}
          />
        </>
      )}
    </Row>
  );
}
