/** A channel's drawer: next steps checked live, "Send a test" for webhooks, the activity log, and its settings. */
import type { ChannelActivity, ChannelOutcome, ChannelSetupStep, ChannelView, Verdict } from "@z/core";
import {
  Check,
  Circle,
  CircleAlert,
  CircleCheck,
  CircleMinus,
  Copy,
  ExternalLink,
  EyeOff,
  Hourglass,
  Info,
  KeyRound,
  RefreshCw,
  Send,
  ShieldX,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { useChannelActivity, useChannelSetup, useTestChannel } from "../api/channels.ts";
import { useSettings } from "../api/settings.ts";
import { CodeBlock, CodeBlockCopyButton } from "../components/ai-elements/code-block.tsx";
import { useT, type Dict } from "../i18n.ts";
import { cn } from "../lib/cn.ts";
import { relativeTime } from "../lib/format.ts";
import { channelIcon } from "../lib/icons.tsx";
import { Button } from "../ui/button.tsx";
import { Badge, LoadError, Loading, Spinner } from "../ui/card.tsx";
import { Disclosure } from "../ui/collapsible.tsx";
import { Drawer } from "../ui/drawer.tsx";
import { Field, Input } from "../ui/field.tsx";
import { IconButton } from "../ui/icon-button.tsx";
import { TabList, TabPanel, TabsRoot } from "../ui/tabs.tsx";
import { notifyError } from "../ui/toast.tsx";

export type DrawerTab = "setup" | "activity" | "settings";

export function ChannelDrawer({
  channel,
  tab,
  onTab,
  secret,
  onClose,
  settings,
}: {
  channel: ChannelView | null;
  tab: DrawerTab;
  onTab: (tab: DrawerTab) => void;
  /** The signing secret just saved, shown once (only while this drawer stays open). */
  secret: string | null;
  onClose: () => void;
  settings: ReactNode;
}) {
  const t = useT();
  const Icon = channel ? channelIcon[channel.kind] : null;
  return (
    <Drawer
      open={channel !== null}
      onOpenChange={(o) => !o && onClose()}
      className="sm:max-w-xl"
      title={
        channel && (
          <>
            {Icon && <Icon aria-hidden className="size-4 shrink-0" />}
            <span className="truncate">{channel.label}</span>
          </>
        )
      }
    >
      {channel && (
        <TabsRoot value={tab} onValueChange={(v) => onTab(v as DrawerTab)} className="flex flex-col">
          <div className="px-4">
            <TabList
              label={channel.label}
              tabs={[
                { value: "setup", label: t.ch_tabSetup },
                { value: "activity", label: t.ch_tabActivity },
                { value: "settings", label: t.ch_tabSettings },
              ]}
            />
          </div>
          <TabPanel value="setup" className="flex flex-col gap-6 p-4">
            {channel.kind === "webhook" && <WebhookPanel channel={channel} secret={secret} />}
            {/* The webhook panel already shows the URL with its note. */}
            <Checklist id={channel.id} hide={channel.kind === "webhook" ? ["webhook.url"] : []} />
          </TabPanel>
          <TabPanel value="activity" className="p-4">
            <ActivityLog id={channel.id} />
          </TabPanel>
          <TabPanel value="settings" className="p-4">
            {settings}
          </TabPanel>
        </TabsRoot>
      )}
    </Drawer>
  );
}

// ─── Copy helpers ───────────────────────────────────────────────────────────

function CopyButton({ value, label }: { value: string; label?: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <IconButton
      label={copied ? t.copied : (label ?? t.copy)}
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
  );
}

function CopyValue({ value, label, className }: { value: string; label?: string; className?: string }) {
  return (
    <div className={cn("flex min-w-0 items-center gap-1 rounded-lg border border-line bg-subtle ps-3", className)}>
      <code className="min-w-0 flex-1 truncate py-1.5 font-mono text-xs" title={value}>
        {value}
      </code>
      <CopyButton value={value} {...(label ? { label } : {})} />
    </div>
  );
}

// ─── Webhook: URL, secret once, Send a test, curl ─────────────────────────────

/** Single-quote a value for sh. */
const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function curlScript(url: string, secret: string, text: string): string {
  const body = JSON.stringify({ text, author: "me" });
  return [
    `SECRET=${shQuote(secret)}`,
    `URL=${shQuote(url)}`,
    `body=${shQuote(body)}`,
    `ts=$(date +%s); id=$(uuidgen 2>/dev/null || openssl rand -hex 16)`,
    `sig=$(printf '%s' "$ts.$id.$body" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.* //')`,
    `curl -sS -X POST "$URL" -H 'content-type: application/json' \\`,
    `  -H "X-Z-Timestamp: $ts" -H "X-Z-Delivery: $id" -H "X-Z-Signature: v1=$sig" -d "$body"`,
  ].join("\n");
}

function WebhookPanel({ channel, secret }: { channel: ChannelView; secret: string | null }) {
  const t = useT();
  const handle = useSettings().data?.handle ?? "z";
  const url = channel.webhookUrl ?? channel.localWebhookUrl ?? "";
  const [text, setText] = useState(() => t.ch_testDefault(handle));
  const test = useTestChannel(channel.id);
  const result = test.data;

  return (
    <div className="flex flex-col gap-5">
      {secret ? (
        <div className="flex flex-col gap-2 rounded-xl border border-warn/40 bg-warn-soft p-3">
          <p className="flex items-start gap-2 text-sm">
            <KeyRound aria-hidden className="mt-0.5 size-4 shrink-0" />
            {t.ch_secretOnce}
          </p>
          <CopyValue value={secret} label={t.ch_copySecret} className="bg-surface" />
        </div>
      ) : (
        <p className="flex items-center gap-2 text-sm text-fg-muted">
          <CircleCheck aria-hidden className="size-4 shrink-0 text-ok" />
          {t.ch_secretSaved}
        </p>
      )}

      <div className="flex flex-col gap-1.5">
        <p className="text-sm font-medium">{t.webhookUrl}</p>
        <CopyValue value={url} label={t.copyWebhook} />
        {!channel.webhookUrl && (
          <p className="flex items-start gap-1.5 text-xs text-fg-muted">
            <Info aria-hidden className="mt-0.5 size-3.5 shrink-0" />
            {t.ch_localUrl}
          </p>
        )}
      </div>

      <form
        className="flex flex-col gap-3 rounded-xl border border-line p-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) test.mutate(text.trim(), { onError: notifyError });
        }}
      >
        <p className="text-sm font-medium">{t.ch_testTitle}</p>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <Field label={t.ch_testMessage} srOnlyLabel className="min-w-0 flex-1">
            <Input value={text} onValueChange={setText} maxLength={2000} />
          </Field>
          <Button type="submit" variant="primary" disabled={test.isPending || !text.trim() || !channel.enabled}>
            {test.isPending ? <Spinner /> : <Send aria-hidden />}
            {t.ch_testTitle}
          </Button>
        </div>
        <p className="text-xs text-fg-muted">{t.ch_testHint}</p>
        {result && (
          <div aria-live="polite" className={cn("flex flex-col gap-1.5 rounded-lg p-3 text-sm", result.error ? "bg-danger-soft" : "bg-subtle")}>
            {result.error ? (
              <p className="text-danger">
                {t.ch_testFailed(String(result.status))}: {result.error}
              </p>
            ) : result.reply ? (
              <>
                <p className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
                  {result.verdict && <VerdictBadge verdict={result.verdict} />}
                  {t.ch_testReplied((result.ms / 1000).toFixed(1))}
                </p>
                <p className="whitespace-pre-wrap break-words" data-testid="test-reply">
                  {result.reply}
                </p>
                {result.sources.length > 0 && (
                  <ul className="flex flex-col gap-0.5 text-xs">
                    {result.sources.map((s) => (
                      <li key={s.url} className="min-w-0 truncate">
                        <a href={s.url} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                          {s.title || s.url}
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            ) : (
              <p className="text-fg-muted">{t.ch_testNoReply}</p>
            )}
          </div>
        )}
      </form>

      <Disclosure summary={t.ch_curlTitle}>
        <div className="flex flex-col gap-2 pt-2">
          <p className="text-xs text-fg-muted">{t.ch_curlHint}</p>
          <CodeBlock code={curlScript(url, secret ?? `<${t.ch_curlSecret}>`, text.trim() || t.ch_testDefault(handle))} language="bash" className="text-xs">
            <CodeBlockCopyButton />
          </CodeBlock>
        </div>
      </Disclosure>
    </div>
  );
}

// ─── Checklist ──────────────────────────────────────────────────────────────

const stepIcon = {
  done: <CircleCheck aria-hidden className="size-4 text-ok" />,
  todo: <Circle aria-hidden className="size-4 text-fg-muted" />,
  error: <CircleAlert aria-hidden className="size-4 text-danger" />,
  info: <Info aria-hidden className="size-4 text-fg-muted" />,
} as const;

/** The step's words in the UI language when the web knows its id, else the server's English. */
function stepLabel(step: ChannelSetupStep, t: Dict): string {
  const known = (t as unknown as Record<string, unknown>)[`ch_step_${step.id.replace(/\./g, "_")}`];
  return typeof known === "string" ? known : step.label;
}

function stepDetail(step: ChannelSetupStep, t: Dict): string | null {
  if (!step.detail) return null;
  if (step.id === "first") return t.ch_lastAt(relativeTime(step.detail));
  if (step.id === "discord.invite" && /^\d+$/.test(step.detail)) return t.ch_inServers(step.detail);
  return step.detail;
}

function Checklist({ id, hide }: { id: string; hide: string[] }) {
  const t = useT();
  const setup = useChannelSetup(id);
  return (
    <section className="flex flex-col gap-2" aria-labelledby={`steps-${id}`}>
      <div className="flex items-center gap-2">
        <h3 id={`steps-${id}`} className="flex-1 text-sm font-medium">
          {t.ch_nextSteps}
        </h3>
        <IconButton label={t.ch_checkAgain} size="icon-sm" onClick={() => void setup.refetch()} disabled={setup.isFetching}>
          <RefreshCw aria-hidden className={cn(setup.isFetching && "animate-spin motion-reduce:animate-none")} />
        </IconButton>
      </div>
      {setup.isPending ? (
        <Loading label={t.ch_checking} className="h-24" />
      ) : setup.error && !setup.data ? (
        <LoadError error={setup.error} onRetry={() => void setup.refetch()} />
      ) : (
        <ol className="flex flex-col divide-y divide-line rounded-xl border border-line">
          {(setup.data ?? []).filter((s) => !hide.includes(s.id)).map((step) => {
            const detail = stepDetail(step, t);
            return (
              <li key={step.id} className="flex gap-3 p-3" data-status={step.status}>
                <span className="mt-0.5 shrink-0">{stepIcon[step.status]}</span>
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <p className={cn("text-sm", step.status === "done" && "text-fg-muted")}>{stepLabel(step, t)}</p>
                  {detail && <p className={cn("text-xs break-words", step.status === "error" ? "text-danger" : "text-fg-muted")}>{detail}</p>}
                  {step.value && <CopyValue value={step.value} />}
                </div>
                {step.link && (
                  <a
                    href={step.link}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={t.ch_openOnPlatform}
                    title={t.ch_openOnPlatform}
                    className="grid size-8 shrink-0 place-items-center rounded-md text-fg-muted hover:bg-subtle hover:text-fg"
                  >
                    <ExternalLink aria-hidden className="size-4" />
                  </a>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

// ─── Activity ───────────────────────────────────────────────────────────────

const outcomeIcon: Record<ChannelOutcome, ReactNode> = {
  answered: <CircleCheck aria-hidden className="size-4 text-ok" />,
  silent: <CircleMinus aria-hidden className="size-4 text-fg-muted" />,
  ignored: <EyeOff aria-hidden className="size-4 text-fg-muted" />,
  limited: <Hourglass aria-hidden className="size-4 text-warn" />,
  error: <CircleAlert aria-hidden className="size-4 text-danger" />,
  rejected: <ShieldX aria-hidden className="size-4 text-danger" />,
};

const verdictTone = { true: "ok", false: "danger", misleading: "warn", unverified: "neutral" } as const;

function VerdictBadge({ verdict }: { verdict: Verdict }) {
  const t = useT();
  return <Badge tone={verdictTone[verdict]}>{t[`ch_verdict_${verdict}`]}</Badge>;
}

function ActivityLog({ id }: { id: string }) {
  const t = useT();
  const activity = useChannelActivity(id);
  if (activity.isPending) return <Loading label={t.loading} className="h-32" />;
  if (activity.error && !activity.data) return <LoadError error={activity.error} onRetry={() => void activity.refetch()} />;
  const list = activity.data ?? [];
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-fg-muted">{t.ch_activityHint}</p>
      {list.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line p-6 text-center text-sm text-fg-muted">{t.ch_activityEmpty}</p>
      ) : (
        <ol className="flex flex-col divide-y divide-line rounded-xl border border-line" data-testid="activity">
          {list.map((a, i) => (
            <ActivityRow key={`${a.at}-${i}`} entry={a} />
          ))}
        </ol>
      )}
    </div>
  );
}

function ActivityRow({ entry: a }: { entry: ChannelActivity }) {
  const t = useT();
  return (
    <li className="flex gap-3 p-3" data-outcome={a.outcome}>
      <span className="mt-0.5 shrink-0">{outcomeIcon[a.outcome]}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="flex flex-wrap items-center gap-x-2 text-xs text-fg-muted">
          <span className={cn("font-medium", a.outcome === "error" || a.outcome === "rejected" ? "text-danger" : "text-fg")}>
            {t[`ch_out_${a.outcome}`]}
          </span>
          {a.count > 1 && <span>{t.ch_times(String(a.count))}</span>}
          <time dateTime={a.at} title={new Date(a.at).toLocaleString()}>
            {relativeTime(a.at)}
          </time>
          {a.ms !== null && a.outcome !== "ignored" && <span>{t.ch_seconds((a.ms / 1000).toFixed(1))}</span>}
          {a.sources > 0 && <span>{t.ch_sources(String(a.sources))}</span>}
        </p>
        {a.preview && (
          <p className="text-sm break-words">
            {a.author && <span className="font-medium">{a.author}: </span>}
            {a.preview}
          </p>
        )}
        {a.reply && (
          <p className="flex flex-wrap items-baseline gap-1.5 border-s-2 border-line ps-2 text-sm break-words text-fg-muted">
            {a.verdict && <VerdictBadge verdict={a.verdict} />}
            <span className="min-w-0">{a.reply}</span>
          </p>
        )}
        {a.detail && <p className="text-xs break-words text-fg-muted">{a.detail}</p>}
      </div>
    </li>
  );
}
