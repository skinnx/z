/** Settings → "Reach me": the paired owner channel and Web Push on this device. */
import { BellRing, Check, Copy, Link2, Monitor, RadioTower, Send, Smartphone, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { useChannels } from "../api/channels.ts";
import { useDisablePush, useEnablePush, useLinkOwner, usePush, useRemoveDevice, useTestPush, useThisDevice, useUnpair } from "../api/reach.ts";
import { useSettings } from "../api/settings.ts";
import { useT } from "../i18n.ts";
import { relativeTime } from "../lib/format.ts";
import { channelIcon } from "../lib/icons.tsx";
import { Button, buttonClass } from "../ui/button.tsx";
import { Badge, Card, Section, Spinner } from "../ui/card.tsx";
import { IconButton } from "../ui/icon-button.tsx";
import { SwitchRow } from "../ui/switch.tsx";
import { notify, notifyError } from "../ui/toast.tsx";

export function ReachSettings() {
  const t = useT();
  return (
    <Section label={t.reachMe} icon={<BellRing aria-hidden />}>
      <OwnerCard />
      <PushCard />
    </Section>
  );
}

type Pairing = { code: string; expiresAt: string; before: string };

function OwnerCard() {
  const t = useT();
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

  const start = () =>
    link.mutate(undefined, { onSuccess: (code) => setPairing({ ...code, before: ownerKey }), onError: notifyError });

  if (pairing) {
    const left = Math.max(0, Date.parse(pairing.expiresAt) - now);
    const command = `/link ${pairing.code}`;
    const handle = settings.data?.handle ?? "z";
    return (
      <Card className="flex flex-col gap-3 p-4">
        {left > 0 ? (
          <>
            <p className="text-sm">{t.pairSend}</p>
            <CopyCode value={command} />
            <p className="text-xs text-fg-muted">
              {t.pairSlack} <code className="font-mono text-fg">@{handle} {command}</code>
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
      </Card>
    );
  }

  if (owner) {
    const channel = channels.find((c) => c.id === owner.channelId);
    const Icon = channel ? channelIcon[channel.kind] : RadioTower;
    return (
      <Card className="flex flex-wrap items-center gap-3 p-4">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent-text">
          <Icon aria-hidden className="size-5" />
        </span>
        <div className="min-w-0 flex-1 basis-48">
          <p className="flex flex-wrap items-center gap-x-2 font-semibold">
            <span className="truncate">{owner.label}</span>
            <Badge tone="ok">
              <Check aria-hidden />
              {t.paired}
            </Badge>
          </p>
          <p className="text-xs text-fg-muted">{t.ownerOn(channel?.label ?? t.channelGone)}</p>
        </div>
        <div className="ms-auto flex gap-2">
          <Button size="sm" onClick={start} disabled={link.isPending}>
            {t.changeOwner}
          </Button>
          <Button size="sm" variant="danger" disabled={unpair.isPending} onClick={() => unpair.mutate(undefined, { onError: notifyError })}>
            {t.unpair}
          </Button>
        </div>
      </Card>
    );
  }

  const pairable = channels.some((c) => c.enabled && c.kind !== "x");
  return (
    <Card className="flex flex-wrap items-center gap-3 p-4">
      <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-subtle text-fg-muted">
        <RadioTower aria-hidden className="size-5" />
      </span>
      <p className="min-w-0 flex-1 basis-48 text-sm text-fg-muted">{pairable ? t.pairIntro : t.pairNeedsChannel}</p>
      {pairable ? (
        <Button size="sm" variant="primary" className="ms-auto" onClick={start} disabled={link.isPending}>
          {link.isPending ? <Spinner /> : <Link2 aria-hidden />}
          {t.pairChannel}
        </Button>
      ) : (
        <Link to="/channels?add" className={buttonClass("secondary", "sm", "ms-auto")}>
          <RadioTower aria-hidden />
          {t.openChannels}
        </Link>
      )}
    </Card>
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

function PushCard() {
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
    <Card>
      <div className="px-4 py-3">
        <SwitchRow
          label={t.pushThisDevice}
          hint={hint}
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
      </div>
      {devices.length > 0 && (
        <>
          <ul className="divide-y divide-line border-t border-line">
            {devices.map((d) => {
              const mobile = /Android|iOS/.test(d.device);
              const Icon = mobile ? Smartphone : Monitor;
              return (
                <li key={d.endpoint} className="flex items-center gap-3 px-4 py-2.5">
                  <Icon aria-hidden className="size-4 shrink-0 text-fg-muted" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2 text-sm">
                      <span className="truncate">{d.device || new URL(d.endpoint).host}</span>
                      {d.endpoint === endpoint && <Badge tone="accent">{t.thisDevice}</Badge>}
                    </span>
                    <span className="block text-xs text-fg-muted">{t.addedAt(relativeTime(d.createdAt))}</span>
                  </span>
                  <IconButton
                    label={t.removeDevice}
                    size="icon-sm"
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(d.endpoint, { onError: notifyError })}
                  >
                    <Trash2 aria-hidden />
                  </IconButton>
                </li>
              );
            })}
          </ul>
          <div className="flex justify-end border-t border-line px-4 py-3">
            <Button
              size="sm"
              disabled={test.isPending}
              onClick={() => test.mutate(undefined, { onSuccess: ({ sent }) => notify("success", t.testSent(sent)), onError: notifyError })}
            >
              {test.isPending ? <Spinner /> : <Send aria-hidden />}
              {t.sendTest}
            </Button>
          </div>
        </>
      )}
    </Card>
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
