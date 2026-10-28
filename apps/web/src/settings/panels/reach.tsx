/** The owner channel: where z reaches you with approvals (with buttons), watch hits and briefings. */
import { Check, Copy, Link2, RadioTower } from "lucide-react";
import { useEffect, useState } from "react";
import { useChannels } from "../../api/channels.ts";
import { useLinkOwner, useUnpair } from "../../api/reach.ts";
import { useSettings } from "../../api/settings.ts";
import { useT } from "../../i18n.ts";
import { channelIcon } from "../../lib/icons.tsx";
import { Confirm } from "../../ui/alert-dialog.tsx";
import { Button } from "../../ui/button.tsx";
import { Badge, Spinner } from "../../ui/card.tsx";
import { IconButton } from "../../ui/icon-button.tsx";
import { Row, RowGroup } from "../../ui/row.tsx";
import { notify, notifyError } from "../../ui/toast.tsx";
import { useSettingsRoute } from "../route.ts";

type Pairing = { code: string; expiresAt: string; before: string };

export function ReachPanel() {
  const t = useT();
  const route = useSettingsRoute();
  const [pairing, setPairing] = useState<Pairing | null>(null);
  // Poll while a code is out: pairing happens in another app.
  const settings = useSettings(pairing ? 2000 : undefined);
  const channels = useChannels().data ?? [];
  const link = useLinkOwner();
  const unpair = useUnpair();
  const owner = settings.data?.owner ?? null;
  const ownerKey = JSON.stringify(owner);
  const now = useNow(pairing !== null);

  useEffect(() => {
    if (pairing && owner && ownerKey !== pairing.before) {
      setPairing(null);
      notify("success", t.paired, owner.label);
    }
  }, [pairing, owner, ownerKey, t]);

  const start = () => link.mutate(undefined, { onSuccess: (code) => setPairing({ ...code, before: ownerKey }), onError: notifyError });

  if (pairing) {
    const left = Math.max(0, Date.parse(pairing.expiresAt) - now);
    const command = `/link ${pairing.code}`;
    const handle = settings.data?.handle ?? "z";
    return (
      <RowGroup>
        <div className="flex flex-col gap-3 py-4">
          {left > 0 ? (
            <>
              <p className="text-sm">{t.pairSend}</p>
              <CopyCode value={command} />
              <p className="text-xs text-fg-muted">
                {t.pairSlack}{" "}
                <code className="font-mono text-fg">
                  @{handle} {command}
                </code>
              </p>
              <div className="flex items-center gap-2 text-sm text-fg-muted" role="status">
                <Spinner className="size-3.5" />
                <span className="min-w-0 flex-1">
                  {t.pairWaiting} <span className="text-xs whitespace-nowrap tabular-nums">{t.pairExpires(clock(left))}</span>
                </span>
                <Button size="sm" variant="ghost" onClick={() => setPairing(null)}>
                  {t.cancel}
                </Button>
              </div>
            </>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <p className="flex-1 text-sm text-fg-muted">{t.pairExpired}</p>
              <Button size="sm" variant="primary" onClick={start} disabled={link.isPending}>
                {link.isPending ? <Spinner /> : <Link2 aria-hidden />}
                {t.pairChannel}
              </Button>
            </div>
          )}
        </div>
      </RowGroup>
    );
  }

  if (owner) {
    const channel = channels.find((c) => c.id === owner.channelId);
    const Icon = channel ? channelIcon[channel.kind] : RadioTower;
    return (
      <RowGroup>
        <Row
          label={
            <span className="flex flex-wrap items-center gap-2">
              <Icon aria-hidden className="size-4 text-accent-text" />
              {owner.label}
              <Badge tone="ok">
                <Check aria-hidden />
                {t.paired}
              </Badge>
            </span>
          }
          hint={t.ownerOn(channel?.label ?? t.channelGone)}
        >
          {() => (
            <>
              <Button size="sm" onClick={start} disabled={link.isPending}>
                {t.changeOwner}
              </Button>
              <Confirm
                trigger={
                  <Button size="sm" variant="danger" disabled={unpair.isPending}>
                    {t.unpair}
                  </Button>
                }
                title={t.unpairConfirm}
                description={t.unpairHint}
                confirmLabel={t.unpair}
                onConfirm={() => unpair.mutateAsync().catch(notifyError)}
              />
            </>
          )}
        </Row>
      </RowGroup>
    );
  }

  const pairable = channels.some((c) => c.enabled && c.kind !== "x");
  return (
    <RowGroup>
      <Row label={t.ownerChannel} hint={pairable ? t.pairIntro : t.pairNeedsChannel}>
        {({ labelId }) =>
          pairable ? (
            <Button size="sm" variant="primary" aria-describedby={labelId} onClick={start} disabled={link.isPending}>
              {link.isPending ? <Spinner /> : <Link2 aria-hidden />}
              {t.pairChannel}
            </Button>
          ) : (
            <Button size="sm" onClick={() => route.leave("/channels?add")}>
              <RadioTower aria-hidden />
              {t.openChannels}
            </Button>
          )
        }
      </Row>
    </RowGroup>
  );
}

function CopyCode({ value }: { value: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-1 self-start rounded-lg border border-line bg-subtle ps-3">
      <code className="font-mono text-lg font-semibold tracking-wide">{value}</code>
      <IconButton
        label={copied ? t.copied : t.copyCommand}
        size="icon-sm"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch (e) {
            notifyError(e);
          }
        }}
      >
        {copied ? <Check aria-hidden className="text-ok" /> : <Copy aria-hidden />}
      </IconButton>
    </div>
  );
}

/** Current time, ticking every second while `active`. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

const clock = (ms: number) => {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
