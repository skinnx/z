import type { AdapterManifest, ChannelInput, ChannelKind, ChannelLimits, ChannelView, Lane } from "@z/core";
import { Form } from "@base-ui/react/form";
import { Check, Copy, Pencil, Plus, RadioTower, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { useAdapters, useChannels, useDeleteChannel, useSaveChannel } from "../api/channels.ts";
import { LANES } from "../api/providers.ts";
import { useSettings } from "../api/settings.ts";
import { useT, type Dict } from "../i18n.ts";
import { cn } from "../lib/cn.ts";
import { relativeTime, slug } from "../lib/format.ts";
import { channelIcon, laneIcon } from "../lib/icons.tsx";
import { Confirm } from "../ui/alert-dialog.tsx";
import { Button } from "../ui/button.tsx";
import { Badge, Card, Empty, Section, Spinner, Loading, LoadError } from "../ui/card.tsx";
import { Disclosure } from "../ui/collapsible.tsx";
import { Dialog } from "../ui/dialog.tsx";
import { Field, Input } from "../ui/field.tsx";
import { IconButton } from "../ui/icon-button.tsx";
import { NumberField } from "../ui/number-field.tsx";
import { Page } from "../ui/page.tsx";
import { RadioCards } from "../ui/radio-cards.tsx";
import { Select } from "../ui/select.tsx";
import { Switch, SwitchRow } from "../ui/switch.tsx";
import { notify, notifyError } from "../ui/toast.tsx";

type Editing = { channel: ChannelView | null; kind: ChannelKind | null };

export default function Channels() {
  const t = useT();
  const channels = useChannels();
  const adapters = useAdapters();
  const [params, setParams] = useSearchParams();
  const [editing, setEditing] = useState<Editing | null>(null);

  useEffect(() => {
    if (params.has("add")) {
      setEditing({ channel: null, kind: null });
      setParams({}, { replace: true });
    }
  }, [params, setParams]);

  if (channels.isPending || adapters.isPending) {
    return (
      <Page title={t.nav_channels}>
        <Loading label={t.loading} className="h-64" />
      </Page>
    );
  }
  const failed = (channels.error && !channels.data && channels) || (adapters.error && !adapters.data && adapters);
  if (failed && failed.error) {
    return (
      <Page title={t.nav_channels}>
        <LoadError error={failed.error} onRetry={() => void failed.refetch()} />
      </Page>
    );
  }
  const list = channels.data ?? [];
  const kinds = adapters.data ?? [];

  return (
    <Page title={t.nav_channels}>
      {list.length === 0 ? (
        <Section label={t.addChannel} hideLabel>
          <Empty icon={<RadioTower />} text={t.channelsEmpty}>
            {kinds.map((a) => {
              const Icon = channelIcon[a.kind];
              return (
                <Button key={a.kind} onClick={() => setEditing({ channel: null, kind: a.kind })}>
                  <Icon aria-hidden />
                  {a.label}
                </Button>
              );
            })}
          </Empty>
        </Section>
      ) : (
        <Section
          label={t.nav_channels}
          hideLabel
          actions={
            <Button variant="primary" onClick={() => setEditing({ channel: null, kind: null })}>
              <Plus aria-hidden />
              {t.addChannel}
            </Button>
          }
        >
          <ul className="grid gap-3 sm:grid-cols-2">
            {list.map((c) => (
              <li key={c.id} className="@container min-w-0">
                <ChannelCard channel={c} onEdit={() => setEditing({ channel: c, kind: c.kind })} />
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Dialog.Root open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <Dialog.Content title={editing?.channel ? editing.channel.label : t.addChannel} wide>
          {editing && (
            <ChannelForm
              key={editing.channel?.id ?? "new"}
              channel={editing.channel}
              initialKind={editing.kind}
              adapters={kinds}
              onDone={() => setEditing(null)}
            />
          )}
        </Dialog.Content>
      </Dialog.Root>
    </Page>
  );
}

const statusDot = { ok: "bg-ok", error: "bg-danger", idle: "bg-line-strong" } as const;

function ChannelCard({ channel: c, onEdit }: { channel: ChannelView; onEdit: () => void }) {
  const t = useT();
  const save = useSaveChannel();
  const Icon = channelIcon[c.kind];
  const LaneIcon = laneIcon[c.lane];
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!c.webhookUrl) return;
    try {
      await navigator.clipboard.writeText(c.webhookUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      notifyError(e);
    }
  };

  return (
    <Card className={cn("flex h-full flex-col gap-3 p-4", !c.enabled && "bg-bg")}>
      <div className="flex items-start gap-3">
        <span className="relative grid size-10 shrink-0 place-items-center rounded-xl bg-subtle">
          <Icon aria-hidden className="size-5" />
          <span className={cn("absolute -end-0.5 -bottom-0.5 size-3 rounded-full ring-2 ring-surface", statusDot[c.status])} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold" title={c.label}>
            {c.label}
          </p>
          <p className="flex flex-wrap items-center gap-x-2 text-xs text-fg-muted">
            <span className={cn(c.status === "error" && "text-danger")}>{t[`st_${c.status}`]}</span>
            <span aria-hidden>·</span>
            {c.lastEventAt ? <time dateTime={c.lastEventAt}>{t.lastEvent(relativeTime(c.lastEventAt))}</time> : <span>{t.neverEvent}</span>}
          </p>
        </div>
        <Switch
          aria-label={`${t.enabled}: ${c.label}`}
          checked={c.enabled}
          onCheckedChange={(enabled) =>
            save.mutate({ id: c.id, kind: c.kind, label: c.label, enabled, always: c.always, lane: c.lane }, { onError: notifyError })
          }
        />
      </div>
      {c.statusDetail && <p className={cn("text-xs break-words", c.status === "error" ? "text-danger" : "text-fg-muted")}>{channelDetail(c.statusDetail, t)}</p>}
      {c.webhookUrl && (
        <div className="flex items-center gap-1 rounded-lg border border-line bg-subtle ps-3">
          <code className="min-w-0 flex-1 truncate font-mono text-xs" title={c.webhookUrl}>
            {c.webhookUrl}
          </code>
          <IconButton label={copied ? t.copied : t.copyWebhook} size="icon-sm" onClick={copy}>
            {copied ? <Check aria-hidden className="text-ok" /> : <Copy aria-hidden />}
          </IconButton>
        </div>
      )}
      <div className="mt-auto flex flex-wrap items-center gap-2">
        <Badge>
          <LaneIcon aria-hidden />
          {t[`lane_${c.lane}`]}
        </Badge>
        {c.always && <Badge>{t.alwaysAnswer}</Badge>}
        <IconButton label={`${t.edit}: ${c.label}`} size="icon-sm" className="ms-auto" onClick={onEdit}>
          <Pencil aria-hidden />
        </IconButton>
      </div>
    </Card>
  );
}

function ChannelForm({
  channel,
  initialKind,
  adapters,
  onDone,
}: {
  channel: ChannelView | null;
  initialKind: ChannelKind | null;
  adapters: AdapterManifest[];
  onDone: () => void;
}) {
  const t = useT();
  const save = useSaveChannel();
  const remove = useDeleteChannel();
  const existing = useChannels().data ?? [];
  const handle = useSettings().data?.handle ?? "z";
  const [kind, setKind] = useState<ChannelKind | null>(channel?.kind ?? initialKind ?? adapters[0]?.kind ?? null);
  const adapter = adapters.find((a) => a.kind === kind);
  const [label, setLabel] = useState(channel?.label ?? adapter?.label ?? "");
  const [id, setId] = useState(channel?.id ?? "");
  const [config, setConfig] = useState<Record<string, string>>({});
  const [always, setAlways] = useState(channel?.always ?? false);
  const [lane, setLane] = useState<Lane>(channel?.lane ?? "bot");
  const [enabled, setEnabled] = useState(channel?.enabled ?? true);
  const [limits, setLimits] = useState<ChannelLimits>(channel?.limits ?? DEFAULT_LIMITS);
  // Toggle config fields: on when stored; saved as "on", or "" to clear.
  const [toggles, setToggles] = useState<Record<string, boolean>>(() =>
    Object.fromEntries((adapter?.config ?? []).filter((f) => f.toggle).map((f) => [f.key, channel?.configured.includes(f.key) ?? false])),
  );
  const textFields = adapter?.config.filter((f) => !f.toggle) ?? [];
  const toggleFields = adapter?.config.filter((f) => f.toggle) ?? [];
  const finalId = channel?.id ?? (id || uniqueId(slug(label) || kind || "channel", existing));
  const idValid = /^[a-z0-9][a-z0-9-]{0,31}$/.test(finalId);

  const pickKind = (k: ChannelKind) => {
    setKind(k);
    const a = adapters.find((x) => x.kind === k);
    if (!channel) setLabel(a?.label ?? k);
    setConfig({});
    setToggles({});
  };

  return (
    <Form
      className="flex flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        if (!kind || !idValid) return;
        // Only send what was typed: blank secret fields keep the stored value.
        const typed = Object.fromEntries(Object.entries(config).filter(([, v]) => v !== ""));
        for (const f of toggleFields) typed[f.key] = toggles[f.key] ? "on" : "";
        const input: ChannelInput = { id: finalId, kind, label: label.trim() || kind, enabled, config: typed, always, lane, limits };
        save.mutate(input, {
          onSuccess: (c) => {
            notify("success", t.saved, c.label);
            onDone();
          },
          onError: notifyError,
        });
      }}
    >
      {!channel && (
        <RadioCards
          label={t.channelKind}
          value={kind ?? ""}
          onChange={(v) => pickKind(v as ChannelKind)}
          options={adapters.map((a) => {
            const Icon = channelIcon[a.kind];
            return { value: a.kind, title: a.label, icon: <Icon aria-hidden className="size-5 shrink-0 text-fg-muted" />, meta: a.mode === "webhook" ? t.webhookUrl : t.connect };
          })}
        />
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t.label}>
          <Input required value={label} onValueChange={setLabel} />
        </Field>
        <Field label={t.id} error={idValid ? undefined : t.idInvalid}>
          <Input
            disabled={!!channel}
            value={channel ? channel.id : id}
            placeholder={finalId}
            onValueChange={(v) => setId(v.toLowerCase())}
            spellCheck={false}
            className="font-mono text-sm"
          />
        </Field>
      </div>

      {adapter && textFields.length > 0 && (
        <fieldset className="grid gap-4 sm:grid-cols-2">
          <legend className="sr-only">{adapter.label}</legend>
          {textFields.map((f) => {
            const stored = channel?.configured.includes(f.key) ?? false;
            return (
              <Field
                key={f.key}
                label={f.label}
                description={stored ? (f.secret ? t.keepSecret : t.saved) : undefined}
                className={cn(textFields.length === 1 && "sm:col-span-2")}
              >
                <Input
                  type={f.secret ? "password" : "text"}
                  autoComplete="off"
                  required={f.required && !stored}
                  value={config[f.key] ?? ""}
                  placeholder={stored ? (f.secret ? "••••••••" : t.blankKeeps) : f.required ? t.required : t.optional}
                  onValueChange={(v) => setConfig((c) => ({ ...c, [f.key]: v }))}
                  spellCheck={false}
                  className={cn(f.secret && "font-mono text-sm")}
                />
              </Field>
            );
          })}
        </fieldset>
      )}
      {toggleFields.map((f) => (
        <SwitchRow
          key={f.key}
          label={f.label}
          checked={toggles[f.key] ?? false}
          onCheckedChange={(on) => setToggles((s) => ({ ...s, [f.key]: on }))}
        />
      ))}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t.lane}>
          <Select<Lane>
            value={lane}
            onChange={setLane}
            options={LANES.map((l) => {
              const Icon = laneIcon[l];
              return { value: l, label: t[`lane_${l}`], icon: <Icon aria-hidden /> };
            })}
          />
        </Field>
        <div className="flex flex-col justify-end gap-1">
          <SwitchRow label={t.enabled} checked={enabled} onCheckedChange={setEnabled} />
        </div>
      </div>
      <SwitchRow label={t.alwaysAnswer} hint={`${t.alwaysAnswerHint} (@${handle})`} checked={always} onCheckedChange={setAlways} />

      <Disclosure summary={t.botLimits}>
        <div className="flex flex-col gap-3 pt-2">
          <p className="text-xs text-fg-muted">{t.botLimitsHint}</p>
          <div className="grid gap-4 sm:grid-cols-2">
            {LIMIT_KEYS.map((key) => (
              <Field key={key} label={t[`limit_${key}`]}>
                <NumberField
                  value={limits[key]}
                  onChange={(v) => setLimits((l) => ({ ...l, [key]: Math.max(LIMIT_MIN[key], Math.round(v ?? DEFAULT_LIMITS[key])) }))}
                  min={LIMIT_MIN[key]}
                  decrementLabel="−1"
                  incrementLabel="+1"
                />
              </Field>
            ))}
          </div>
        </div>
      </Disclosure>

      {channel && adapter?.mode === "webhook" && !channel.webhookUrl && <p className="text-xs text-fg-muted">{t.needsPublicUrl}</p>}

      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
        {channel && (
          <Confirm
            trigger={
              <Button variant="danger">
                <Trash2 aria-hidden />
                {t.delete}
              </Button>
            }
            title={t.deleteChannelConfirm}
            confirmLabel={t.deleteChannel}
            onConfirm={() => remove.mutateAsync(channel.id).then(onDone, notifyError)}
          />
        )}
        <Button type="submit" variant="primary" className="ms-auto" disabled={save.isPending || !kind || !idValid}>
          {save.isPending ? <Spinner /> : <Check aria-hidden />}
          {channel ? t.save : t.connect}
        </Button>
      </div>
    </Form>
  );
}

/** The server's ChannelLimits defaults and minimums, for a channel not saved yet. */
const DEFAULT_LIMITS: ChannelLimits = { running: 4, waiting: 20, authorWaiting: 2, authorHourly: 10 };
const LIMIT_MIN: ChannelLimits = { running: 1, waiting: 0, authorWaiting: 1, authorHourly: 1 };
const LIMIT_KEYS = ["running", "waiting", "authorWaiting", "authorHourly"] as const;

/**
 * The server words channel status in English. Its fixed phrases are reworded here; the platform's own
 * error text after "Could not connect:" / "Bot failed:" stays as the platform wrote it.
 */
function channelDetail(detail: string, t: Dict): string {
  const fixed: Record<string, string> = {
    Disabled: t.chd_disabled,
    Connected: t.st_ok,
    "Waiting for the first webhook": t.chd_waitingWebhook,
    "Set Z_PUBLIC_URL so the platform can reach /hooks": t.needsPublicUrl,
  };
  if (fixed[detail]) return fixed[detail];
  for (const [prefix, key] of [
    ["Could not connect: ", "chd_couldNotConnect"],
    ["Bot failed: ", "chd_botFailed"],
  ] as const) {
    if (detail.startsWith(prefix)) return `${t[key]}: ${detail.slice(prefix.length)}`;
  }
  return detail;
}

function uniqueId(base: string, existing: ChannelView[]): string {
  if (!existing.some((c) => c.id === base)) return base;
  for (let i = 2; ; i++) if (!existing.some((c) => c.id === `${base}-${i}`)) return `${base}-${i}`;
}
