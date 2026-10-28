/** Web Push: this device, the other subscribed devices, and a test send. */
import { Monitor, Send, Smartphone, Trash2 } from "lucide-react";
import { useDisablePush, useEnablePush, usePush, useRemoveDevice, useTestPush, useThisDevice } from "../../api/reach.ts";
import { useT } from "../../i18n.ts";
import { relativeTime } from "../../lib/format.ts";
import { Button } from "../../ui/button.tsx";
import { Badge, Spinner } from "../../ui/card.tsx";
import { IconButton } from "../../ui/icon-button.tsx";
import { Row, RowGroup } from "../../ui/row.tsx";
import { Switch } from "../../ui/switch.tsx";
import { notify, notifyError } from "../../ui/toast.tsx";

export function NotificationsPanel() {
  const t = useT();
  const push = usePush();
  const here = useThisDevice().data;
  const enable = useEnablePush();
  const disable = useDisablePush();
  const remove = useRemoveDevice();
  const test = useTestPush();
  const devices = push.data?.devices ?? [];
  const endpoint = here?.support === "ok" ? here.endpoint : null;
  const on = endpoint !== null && devices.some((d) => d.endpoint === endpoint);
  const busy = enable.isPending || disable.isPending;
  const hint = !here
    ? t.loading
    : here.support === "none"
      ? here.ios
        ? t.pushInstall
        : t.pushUnsupported
      : here.permission === "denied"
        ? t.pushBlocked
        : on
          ? t.pushOn
          : t.pushOff;

  return (
    <>
      <RowGroup>
        <Row label={t.pushThisDevice} hint={hint}>
          {({ labelId, hintId }) => (
            <Switch
              aria-labelledby={labelId}
              aria-describedby={hintId}
              checked={on}
              disabled={busy || !push.data || here?.support !== "ok" || here.permission === "denied"}
              onCheckedChange={(next) => {
                if (next && push.data) {
                  enable.mutate(push.data.publicKey, {
                    onError: (e) => (e.message === "blocked" ? notify("error", t.pushBlocked) : notifyError(e)),
                  });
                } else disable.mutate(undefined, { onError: notifyError });
              }}
            />
          )}
        </Row>
        <Row label={t.testNotification} hint={devices.length ? t.testHint : t.noDevices}>
          {({ labelId }) => (
            <Button
              size="sm"
              aria-describedby={labelId}
              disabled={test.isPending || devices.length === 0}
              onClick={() => test.mutate(undefined, { onSuccess: ({ sent }) => notify("success", t.testSent(sent)), onError: notifyError })}
            >
              {test.isPending ? <Spinner /> : <Send aria-hidden />}
              {t.sendTest}
            </Button>
          )}
        </Row>
      </RowGroup>
      {devices.length > 0 && (
        <RowGroup label={t.devices}>
          {devices.map((d) => {
            const Icon = /Android|iOS/.test(d.device) ? Smartphone : Monitor;
            const name = d.device || new URL(d.endpoint).host;
            return (
              <div key={d.endpoint} className="flex items-center gap-3 py-3">
                <Icon aria-hidden className="size-4 shrink-0 text-fg-muted" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 text-sm">
                    <span className="truncate">{name}</span>
                    {d.endpoint === endpoint && <Badge tone="accent">{t.thisDevice}</Badge>}
                  </span>
                  <span className="block text-xs text-fg-muted">{t.addedAt(relativeTime(d.createdAt))}</span>
                </span>
                <IconButton
                  label={`${t.removeDevice}: ${name}`}
                  size="icon-sm"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(d.endpoint, { onError: notifyError })}
                >
                  <Trash2 aria-hidden />
                </IconButton>
              </div>
            );
          })}
        </RowGroup>
      )}
    </>
  );
}
