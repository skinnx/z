import type { Lane, ModelRef, ProviderInput, ProviderSaveResult, ProviderView, Routing } from "@z/core";
import { ArrowDown, ArrowUp, Check, CircleAlert, CircleCheck, CircleDashed, Gift, LockKeyhole, Pencil, Plus, Route, Trash2, X, Zap } from "lucide-react";
import { Form } from "@base-ui/react/form";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import {
  checkFailed,
  LANES,
  useDeleteProvider,
  useModelRefs,
  useProviderCheck,
  useProviderModels,
  useProviders,
  useRouting,
  useSaveCheckedProvider,
  useSaveProvider,
  useSaveRouting,
  useTestProvider,
  type ProviderTest,
} from "../api/providers.ts";
import { ErrorFix } from "../components/error-fix.tsx";
import { useSetup } from "../api/setup.ts";
import { useT } from "../i18n.ts";
import { cn } from "../lib/cn.ts";
import { classifyError } from "../lib/errors.ts";
import { compact, slug, usd } from "../lib/format.ts";
import { laneIcon } from "../lib/icons.tsx";
import { PRESETS, presetFor, splitRef, type ProviderPreset } from "../lib/models.ts";
import { Confirm } from "../ui/alert-dialog.tsx";
import { Monogram } from "../ui/avatar.tsx";
import { Button, ExternalLinkButton, Tile } from "../ui/button.tsx";
import { Badge, Card, Section, Spinner, Loading, LoadError } from "../ui/card.tsx";
import { ComboboxAdd } from "../ui/combobox.tsx";
import { Dialog } from "../ui/dialog.tsx";
import { Field, Input } from "../ui/field.tsx";
import { IconButton } from "../ui/icon-button.tsx";
import { Meter } from "../ui/meter.tsx";
import { NumberField } from "../ui/number-field.tsx";
import { Page } from "../ui/page.tsx";
import { RadioCards } from "../ui/radio-cards.tsx";
import { Switch, SwitchRow } from "../ui/switch.tsx";
import { notify, notifyError } from "../ui/toast.tsx";

/** The field an error's fix opens the provider form on. */
type FormFocus = "key" | "models" | null;

export default function Models() {
  const t = useT();
  const providers = useProviders();
  const [params, setParams] = useSearchParams();
  const [editing, setEditing] = useState<ProviderView | "new" | null>(null);
  // Deep links from an error's fix: `?edit=<provider>` opens it on its key, `?lane=<lane>` lands on that routing lane.
  const [focus, setFocus] = useState<FormFocus>(null);
  const [focusLane, setFocusLane] = useState<Lane | null>(null);
  const clearLane = useCallback(() => setFocusLane(null), []);

  useEffect(() => {
    if (params.has("add")) {
      setEditing("new");
      setParams({}, { replace: true });
      return;
    }
    const edit = params.get("edit");
    if (edit !== null && providers.data) {
      const p = providers.data.find((x) => x.id === edit);
      if (p) {
        setFocus("key");
        setEditing(p);
      }
      setParams({}, { replace: true });
      return;
    }
    const lane = params.get("lane");
    if (lane !== null) {
      if ((LANES as readonly string[]).includes(lane)) setFocusLane(lane as Lane);
      setParams({}, { replace: true });
    }
  }, [params, setParams, providers.data]);

  if (providers.isPending) {
    return (
      <Page title={t.nav_models}>
        <Loading label={t.loading} className="h-64" />
      </Page>
    );
  }

  if (providers.error && !providers.data) {
    return (
      <Page title={t.nav_models}>
        <LoadError error={providers.error} onRetry={() => void providers.refetch()} />
      </Page>
    );
  }
  const list = providers.data ?? [];

  return (
    <Page title={t.nav_models}>
      {list.length === 0 ? (
        <FirstRun onNeedsFix={setEditing} />
      ) : (
        <>
          <Section
            label={t.nav_models}
            hideLabel
            actions={
              <Button variant="primary" onClick={() => setEditing("new")}>
                <Plus aria-hidden />
                {t.addProvider}
              </Button>
            }
          >
            <div className="@container grid gap-3">
              {list.map((p) => (
                <ProviderCard
                  key={p.id}
                  provider={p}
                  onEdit={(field) => {
                    setFocus(field ?? null);
                    setEditing(p);
                  }}
                  onPickLane={setFocusLane}
                />
              ))}
            </div>
          </Section>
          <RoutingEditor focusLane={focusLane} onFocused={clearLane} />
        </>
      )}

      <Dialog.Root
        open={editing !== null}
        onOpenChange={(o) => {
          if (o) return;
          setEditing(null);
          setFocus(null);
        }}
      >
        <Dialog.Content title={editing === "new" || editing === null ? t.addProvider : editing.label} wide>
          {editing !== null && (
            <ProviderForm
              key={editing === "new" ? "new" : editing.id}
              provider={editing === "new" ? null : editing}
              focus={focus}
              onPickLane={(lane) => {
                setEditing(null);
                setFocusLane(lane);
              }}
              onSaved={(p) => setEditing(p)}
              onDeleted={() => setEditing(null)}
            />
          )}
        </Dialog.Content>
      </Dialog.Root>
    </Page>
  );
}

/**
 * After a checked save: a provider that answered while setup was blocking sends the owner to Today;
 * otherwise they stay with the result shown inline. Returns whether the check failed outright.
 */
function useAfterCheck() {
  const t = useT();
  const navigate = useNavigate();
  const setup = useSetup();
  const blocking = setup.data?.rows.find((r) => r.id === "chat_model")?.state !== "ready";
  return (p: ProviderSaveResult, wasBlocking = blocking): boolean => {
    const c = p.check;
    if (c?.ok && wasBlocking && p.filledLanes?.length) {
      notify("success", t.providerReady(p.label), t.testOk(c.latencyMs ?? 0, c.model ?? ""));
      void navigate("/");
    } else if (c?.ok) notify("success", t.saved, t.testOk(c.latencyMs ?? 0, c.model ?? ""));
    else if (c?.rateLimited || c?.timedOut) notify("success", t.saved, c.rateLimited ? t.checkRateLimited(p.label) : t.checkTimedOut(p.label));
    else if (!c) notify("success", t.saved, p.label);
    return checkFailed(c);
  };
}

/** No providers yet: one tap to a free provider that works, or bring your own key right here. */
function FirstRun({ onNeedsFix }: { onNeedsFix: (p: ProviderView) => void }) {
  const t = useT();
  const save = useSaveCheckedProvider();
  const after = useAfterCheck();
  const free = PRESETS.filter((p) => p.free);
  const [picked, setPicked] = useState<string | null>(null);

  const start = (preset: ProviderPreset) => {
    setPicked(preset.key);
    save.mutate(
      { id: preset.id, kind: preset.kind, label: preset.label, baseURL: preset.baseURL, models: preset.models ?? [], enabled: true },
      { onSuccess: (p) => after(p, true) && onNeedsFix(p), onError: notifyError },
    );
  };

  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby="start-free" className="flex flex-col gap-3 rounded-(--radius-card) border border-accent/50 bg-accent-soft p-4 sm:p-5">
        <div>
          <h2 id="start-free" className="flex items-center gap-2 text-base font-semibold">
            <Zap aria-hidden className="size-5 text-accent-text" />
            {t.startFree}
          </h2>
          <p className="mt-1 text-sm text-fg-muted">{t.startFreeMeta}</p>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          {free.map((preset) => {
            const busy = save.isPending && picked === preset.key;
            return (
              <Tile key={preset.key} onClick={() => start(preset)} disabled={save.isPending} aria-busy={busy || undefined} className="bg-surface!">
                <span aria-hidden className="contents">
                  <Monogram text={preset.mark} className="normal-case" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold">{preset.label}</span>
                  <span className="block text-xs text-fg-muted">{busy ? t.checkingProvider : t[`freeMeta_${preset.key as "llm7" | "pollinations"}`]}</span>
                </span>
                {busy ? <Spinner /> : <ArrowUp aria-hidden className="size-5 shrink-0 rotate-45 text-accent-text rtl:-rotate-45" />}
              </Tile>
            );
          })}
        </div>
      </section>
      <div className="flex items-center gap-3 text-xs text-fg-muted">
        <span className="h-px flex-1 bg-line" />
        {t.orBringKey}
        <span className="h-px flex-1 bg-line" />
      </div>
      <Card className="p-5">
        <ProviderForm provider={null} defaultPreset="openai" presets={PRESETS.filter((p) => !p.free)} firstRun onSaved={onNeedsFix} onDeleted={() => {}} />
      </Card>
    </div>
  );
}

function ProviderCard({ provider: p, onEdit, onPickLane }: { provider: ProviderView; onEdit: (focus?: FormFocus) => void; onPickLane: (lane: Lane) => void }) {
  const t = useT();
  const test = useTestProvider();
  const save = useSaveProvider();
  const check = useProviderCheck(p.id);
  const preset = presetFor(p.kind, p.baseURL);
  const budget = p.monthlyBudgetUsd;

  return (
    <Card className={cn("flex flex-col gap-4 p-4 @xl:flex-row @xl:items-center", !p.enabled && "bg-bg")}>
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <Monogram text={preset.label === p.label ? preset.mark : p.label} className="normal-case" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate font-semibold" title={p.label}>
              {p.label}
            </span>
            <code className="font-mono text-xs text-fg-muted">{p.id}</code>
            {preset.free && (
              <Badge tone="accent">
                <Gift aria-hidden />
                {t.free}
              </Badge>
            )}
            {checkFailed(check) && (
              <Badge tone="danger">
                <CircleAlert aria-hidden />
                {/^\s*40[13]\b/.test(check?.error ?? "") ? t.keyRejected : t.notAnswering}
              </Badge>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-muted">
            <span className="flex items-center gap-1">
              <LockKeyhole aria-hidden className="size-3.5" />
              {p.kind === "codex-cli" ? t.codexViaCli : p.hasKey ? <span className="font-mono">••••{p.keyHint}</span> : t.noKey}
            </span>
            <span>{t.modelCount(p.models.length)}</span>
          </div>
        </div>
      </div>

      <div className="flex w-full flex-col gap-1 @xl:w-56">
        {budget ? (
          <Meter value={p.usage.monthUsd} max={budget} label={t.thisMonth} valueText={t.usedOf(usd(p.usage.monthUsd), usd(budget))} />
        ) : (
          <p className="flex justify-between text-xs text-fg-muted">
            <span>{t.thisMonth}</span>
            {/* Free providers bill nothing: the rough per-token estimate would only confuse. */}
            <span className="text-fg tabular-nums">{preset.free ? t.tokens(compact(p.usage.monthTokens)) : `${usd(p.usage.monthUsd)} · ${t.tokens(compact(p.usage.monthTokens))}`}</span>
          </p>
        )}
        <TestResult
          result={check}
          label={p.label}
          error={test.error}
          pending={test.isPending}
          fixes={{ provider: p, onFixKey: () => onEdit("key"), onPickModel: () => onEdit("models"), onOtherModel: () => onPickLane("chat"), onRetry: () => test.mutate(p.id) }}
        />
      </div>

      <div className="flex items-center gap-1 @xl:ms-2">
        <Button size="sm" onClick={() => test.mutate(p.id)} disabled={test.isPending || !p.enabled}>
          {test.isPending ? <Spinner /> : <Zap aria-hidden />}
          {test.isPending ? t.testing : t.test}
        </Button>
        <IconButton label={`${t.edit}: ${p.label}`} size="icon-sm" onClick={() => onEdit()}>
          <Pencil aria-hidden />
        </IconButton>
        <Switch
          aria-label={`${t.enabled}: ${p.label}`}
          checked={p.enabled}
          className="ms-auto @xl:ms-1"
          onCheckedChange={(enabled) => save.mutate(viewToInput(p, { enabled }), { onError: notifyError })}
        />
      </div>
    </Card>
  );
}

/** Where a failed test's fix lands: the key or model list of this provider, or a routing lane. */
type TestFixes = { provider: ProviderView; onFixKey: () => void; onPickModel: () => void; onOtherModel: () => void; onRetry: () => void };

function TestResult({ result, label, error, pending, fixes }: { result?: ProviderTest; label: string; error: Error | null; pending: boolean; fixes: TestFixes }) {
  const t = useT();
  // Rate limited or slow says nothing about the key: report it calmly instead of offering a fix.
  const inconclusive = result && !result.ok && (result.rateLimited || result.timedOut);
  const failure: unknown = error ?? (result && !result.ok && !inconclusive ? (result.error ?? t.fix_unknown) : null);
  if (!pending && failure)
    return (
      <div aria-live="polite">
        <ErrorFix
          variant="inline"
          error={failure}
          provider={fixes.provider}
          onFixKey={fixes.onFixKey}
          onPickModel={classifyError(failure) === "quota" ? fixes.onOtherModel : fixes.onPickModel}
          onRetry={fixes.onRetry}
        />
      </div>
    );
  return (
    <p aria-live="polite" className="min-h-4 text-xs">
      {pending ? null : inconclusive ? (
        <span className="flex items-start gap-1 text-fg-muted">
          <CircleDashed aria-hidden className="mt-px size-3.5 shrink-0" />
          <span className="break-words">{result.rateLimited ? t.checkRateLimited(label) : t.checkTimedOut(label)}</span>
        </span>
      ) : result?.ok ? (
        <span className="flex items-center gap-1 text-ok">
          <CircleCheck aria-hidden className="size-3.5 shrink-0" />
          {t.testOk(result.latencyMs ?? 0, result.model ?? "")}
        </span>
      ) : null}
      {!pending && result?.account?.signedIn && (
        <span className="mt-0.5 block text-fg-muted">
          {result.account.method === "chatgpt" ? t.codexSignedIn(result.account.plan, result.account.email) : result.account.method === "apiKey" ? t.codexSignedInApiKey : null}
        </span>
      )}
    </p>
  );
}

function viewToInput(p: ProviderView, patch: Partial<ProviderInput> = {}): ProviderInput {
  return {
    id: p.id,
    kind: p.kind,
    label: p.label,
    ...(p.baseURL ? { baseURL: p.baseURL } : {}),
    ...(p.headers ? { headers: p.headers } : {}),
    models: p.models,
    enabled: p.enabled,
    ...(p.monthlyBudgetUsd !== undefined ? { monthlyBudgetUsd: p.monthlyBudgetUsd } : {}),
    ...(p.command ? { command: p.command } : {}),
    ...patch,
  };
}

function ProviderForm({
  provider,
  onSaved,
  onDeleted,
  defaultPreset = "llm7",
  focus = null,
  onPickLane,
  presets = PRESETS,
  firstRun = false,
}: {
  defaultPreset?: string;
  /** Opened as the fix for an error: land on the key or the model list. */
  focus?: FormFocus;
  onPickLane?: (lane: Lane) => void;
  presets?: ProviderPreset[];
  /** Setup is blocking: a provider that answers sends the owner to Today. */
  firstRun?: boolean;
  provider: ProviderView | null;
  onSaved: (p: ProviderView) => void;
  onDeleted: () => void;
}) {
  const t = useT();
  const formId = useId();
  const save = useSaveCheckedProvider();
  const plainSave = useSaveProvider();
  const after = useAfterCheck();
  const remove = useDeleteProvider();
  const test = useTestProvider();
  const check = useProviderCheck(provider?.id ?? null);
  const existing = useProviders().data ?? [];
  const [preset, setPreset] = useState<ProviderPreset>(() => (provider ? presetFor(provider.kind, provider.baseURL) : presets.find((p) => p.key === defaultPreset) ?? presets[0]!));
  const [label, setLabel] = useState(provider?.label ?? preset.label);
  const [id, setId] = useState(provider?.id ?? uniqueId(preset.id, existing));
  const [idTouched, setIdTouched] = useState(false);
  const [baseURL, setBaseURL] = useState(provider?.baseURL ?? (preset.fixedBaseURL ? preset.baseURL ?? "" : ""));
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState<string[]>(provider?.models ?? preset.models ?? []);
  const [budget, setBudget] = useState<number | null>(provider?.monthlyBudgetUsd ?? null);
  const [enabled, setEnabled] = useState(provider?.enabled ?? true);
  const [command, setCommand] = useState(provider?.command ?? "");
  const live = useProviderModels(provider?.id ?? null);
  const keyRef = useRef<HTMLInputElement>(null);
  const modelsRef = useRef<HTMLFieldSetElement>(null);
  const focusField = (field: FormFocus) => {
    const el = field === "key" ? keyRef.current : field === "models" ? modelsRef.current?.querySelector("input") : null;
    el?.scrollIntoView({ block: "center" });
    el?.focus();
  };
  useEffect(() => {
    // After the dialog's own initial focus.
    if (!focus) return;
    const id = setTimeout(() => focusField(focus), 50);
    return () => clearTimeout(id);
  }, [focus]);

  const choosePreset = (key: string) => {
    const next = presets.find((p) => p.key === key)!;
    setPreset(next);
    setLabel(next.label);
    if (!idTouched) setId(uniqueId(next.id, existing));
    setBaseURL(next.fixedBaseURL ? next.baseURL ?? "" : "");
    setModels(next.models ?? []);
  };

  const urlRequired = preset.kind === "openai-compatible";
  // The Codex CLI owns sign-in: no key, endpoint or budget (it bills the owner's ChatGPT plan).
  const codex = preset.kind === "codex-cli";
  const idValid = /^[a-z0-9][a-z0-9-]{0,31}$/.test(id);
  const idTaken = !provider && existing.some((p) => p.id === id);
  const suggestions = useMemo(() => (live.data ?? []).filter((m) => !models.includes(m)), [live.data, models]);

  const submit = () => {
    if (!idValid || idTaken) return;
    const input: ProviderInput = {
      id,
      kind: preset.kind,
      label: label.trim() || preset.label,
      ...(baseURL.trim() && !codex ? { baseURL: baseURL.trim() } : {}),
      ...(apiKey && !codex ? { apiKey } : {}),
      ...(codex && command.trim() ? { command: command.trim() } : {}),
      ...(provider?.headers ? { headers: provider.headers } : {}),
      ...(provider?.contextWindows ? { contextWindows: provider.contextWindows } : {}),
      models,
      enabled,
      ...(budget !== null ? { monthlyBudgetUsd: budget } : {}),
    };
    // Check live when it is new or how z reaches it changed; other edits (label, budget) save as is.
    const reach = !provider || !!apiKey || (baseURL.trim() || undefined) !== provider.baseURL || models.length === 0 || (!provider.enabled && enabled);
    if (!reach) {
      plainSave.mutate(input, {
        onSuccess: (p) => {
          notify("success", t.saved, p.label);
          onSaved(p);
        },
        onError: notifyError,
      });
      return;
    }
    save.mutate(input, {
      onSuccess: (p) => {
        setApiKey("");
        const failed = after(p, firstRun || undefined);
        // First run: only a failed check needs the form again (the dialog opens on it); otherwise the page moves on.
        if (!firstRun || failed) onSaved(p);
      },
      onError: notifyError,
    });
  };
  const saving = save.isPending || plainSave.isPending;

  return (
    <Form
      id={formId}
      className="flex flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {!provider && (
        <RadioCards
          label={t.providerKind}
          value={preset.key}
          onChange={choosePreset}
          options={presets.map((p) => ({
            value: p.key,
            title: p.label,
            meta: p.free ? t.freeNoKey : p.kind === "codex-cli" ? t.codexMeta : p.needsKey ? undefined : t.noKeyNeeded,
            icon: p.free ? <Gift aria-hidden className="size-4 shrink-0 text-accent-text" /> : <Monogram text={p.mark} className="size-8 rounded-lg text-xs normal-case" />,
          }))}
        />
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t.label}>
          <Input
            required
            value={label}
            onValueChange={(v) => {
              setLabel(v);
              if (!provider && !idTouched) setId(uniqueId(slug(v) || preset.id, existing));
            }}
          />
        </Field>
        <Field label={t.id} description={t.idHint} error={!idValid ? t.idInvalid : idTaken ? t.idTaken : undefined}>
          <Input
            required
            disabled={!!provider}
            value={id}
            onValueChange={(v) => {
              setIdTouched(true);
              setId(v.toLowerCase());
            }}
            spellCheck={false}
            className="font-mono text-sm"
          />
        </Field>
      </div>

      {codex ? (
        <>
          <p className="text-sm text-fg-muted">{t.codexNote}</p>
          <Field label={t.codexPath} description={t.codexPathHint}>
            <Input value={command} onValueChange={setCommand} placeholder="codex" spellCheck={false} className="font-mono text-sm" />
          </Field>
        </>
      ) : (
        <>
          <Field label={t.apiKey} description={provider?.hasKey ? `${t.keepSecret} ••••${provider.keyHint ?? ""}` : `${preset.needsKey ? `${t.keyNeeded} ` : ""}${t.keyStaysHere}`}>
            <div className="flex gap-2">
              <Input
                ref={keyRef}
                type="password"
                autoComplete="off"
                value={apiKey}
                onValueChange={setApiKey}
                placeholder={preset.needsKey ? "sk-…" : t.optional}
                className="font-mono text-sm"
              />
              {preset.docs && <ExternalLinkButton href={preset.docs}>{t.getKey}</ExternalLinkButton>}
            </div>
          </Field>

          <Field label={t.baseURL} description={!urlRequired && preset.baseURL ? `${t.defaultIs} ${preset.baseURL}` : undefined}>
            <Input
              type="url"
              required={urlRequired}
              value={baseURL}
              onValueChange={setBaseURL}
              placeholder={preset.baseURL ?? "https://…/v1"}
              spellCheck={false}
              className="font-mono text-sm"
            />
          </Field>
        </>
      )}

      {/* min-w-0: a fieldset is min-content wide by default, so one long model id would widen the dialog. */}
      <fieldset ref={modelsRef} className="flex min-w-0 flex-col gap-2">
        <legend className="mb-1.5 flex w-full items-center justify-between text-sm font-medium">
          {t.models}
          {provider && live.data && <span className="text-xs font-normal text-fg-muted">{t.modelsLoaded(live.data.length)}</span>}
        </legend>
        {models.length > 0 && (
          <ul className="flex flex-wrap gap-1.5">
            {models.map((m) => (
              <li key={m} className="inline-flex min-h-8 max-w-full min-w-0 items-center gap-1 rounded-lg border border-line bg-subtle ps-2.5 font-mono text-xs">
                <span className="min-w-0 truncate" title={m}>
                  {m}
                </span>
                <IconButton label={`${t.remove}: ${m}`} size="icon-sm" className="text-fg-muted hover:bg-surface hover:text-fg" onClick={() => setModels(models.filter((x) => x !== m))}>
                  <X aria-hidden className="size-3.5!" />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
        <ComboboxAdd
          aria-label={t.addModel}
          placeholder={provider ? (live.isPending ? t.loading : t.searchModels) : t.addModel}
          items={suggestions}
          allowCustom
          mono
          emptyText={t.typeModelId}
          onAdd={(m) => setModels((list) => (list.includes(m) ? list : [...list, m]))}
        />
        {!provider && models.length === 0 && <p className="text-xs text-fg-muted">{t.saveToLoadModels}</p>}
        {/* A failed check below already says why the list did not load. */}
        {provider && live.error && !checkFailed(check) && <p className="text-xs break-words text-fg-muted">{live.error.message}</p>}
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        {!codex && (
          <Field label={t.budget}>
            <NumberField
              value={budget}
              onChange={setBudget}
              min={0}
              step={5}
              placeholder="—"
              format={{ style: "currency", currency: "USD", maximumFractionDigits: 2 }}
              decrementLabel="−5"
              incrementLabel="+5"
            />
          </Field>
        )}
        <div className="flex items-end">
          <div className="w-full">
            <SwitchRow label={t.enabled} checked={enabled} onCheckedChange={setEnabled} />
          </div>
        </div>
      </div>

      {provider && (
        <TestResult
          result={check}
          label={provider.label}
          error={test.error}
          pending={test.isPending || save.isPending}
          fixes={{
            provider,
            onFixKey: () => focusField("key"),
            onPickModel: () => focusField("models"),
            onOtherModel: () => onPickLane?.("chat"),
            onRetry: () => test.mutate(provider.id),
          }}
        />
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
        {provider && (
          <Confirm
            trigger={
              <Button variant="danger">
                <Trash2 aria-hidden />
                {t.delete}
              </Button>
            }
            title={t.deleteProviderConfirm}
            confirmLabel={t.deleteProvider}
            onConfirm={() => remove.mutateAsync(provider.id).then(onDeleted, notifyError)}
          />
        )}
        <div className="ms-auto flex gap-2">
          {provider && (
            <Button onClick={() => test.mutate(provider.id)} disabled={test.isPending}>
              {test.isPending ? <Spinner /> : <Zap aria-hidden />}
              {t.test}
            </Button>
          )}
          <Button type="submit" variant="primary" disabled={saving || !idValid || idTaken} aria-busy={saving || undefined}>
            {saving ? <Spinner /> : provider ? <Check aria-hidden /> : <Plus aria-hidden />}
            {save.isPending ? t.checkingProvider : provider ? t.save : t.addProvider}
          </Button>
        </div>
      </div>
    </Form>
  );
}

function uniqueId(base: string, existing: ProviderView[]): string {
  const root = base || "provider";
  if (!existing.some((p) => p.id === root)) return root;
  for (let i = 2; ; i++) if (!existing.some((p) => p.id === `${root}-${i}`)) return `${root}-${i}`;
}

function RoutingEditor({ focusLane, onFocused }: { focusLane: Lane | null; onFocused: () => void }) {
  const t = useT();
  const routing = useRouting();
  const save = useSaveRouting();
  const refs = useModelRefs();
  const providers = useProviders().data ?? [];
  const current = routing.data;
  const laneRefs = useRef<Partial<Record<Lane, HTMLDivElement | null>>>({});
  const [highlight, setHighlight] = useState<Lane | null>(null);

  // Landed here to pick another model: show the lane and put the cursor in its "add" box.
  useEffect(() => {
    if (!focusLane || !current) return;
    const el = laneRefs.current[focusLane];
    if (!el) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
    el.querySelector("input")?.focus({ preventScroll: true });
    setHighlight(focusLane);
    onFocused();
  }, [focusLane, current, onFocused]);
  useEffect(() => {
    if (!highlight) return;
    const id = setTimeout(() => setHighlight(null), 2500);
    return () => clearTimeout(id);
  }, [highlight]);

  const update = (lane: Lane, chain: ModelRef[]) => {
    if (!current) return;
    const next: Routing = { ...current, [lane]: chain };
    save.mutate(next, { onError: notifyError });
  };

  return (
    <Section label={t.routing} icon={<Route aria-hidden />}>
      {routing.error && !current ? (
        <LoadError error={routing.error} onRetry={() => void routing.refetch()} />
      ) : !current ? (
        <Loading label={t.loading} className="h-24" />
      ) : (
        <div className="@container grid gap-3 md:grid-cols-2">
          {LANES.map((lane) => {
            const chain = current[lane] ?? [];
            const Icon = laneIcon[lane];
            return (
              <Card
                key={lane}
                ref={(el) => {
                  laneRefs.current[lane] = el;
                }}
                data-lane={lane}
                className={cn("flex min-w-0 flex-col p-3 transition-shadow", highlight === lane && "ring-2 ring-accent")}
              >
                <h3 className="flex items-center gap-2 px-1 pb-2 text-sm font-semibold">
                  <Icon aria-hidden className="size-4 text-fg-muted" />
                  {t[`lane_${lane}`]}
                </h3>
                {chain.length === 0 ? (
                  lane === "fast" && current.agent?.length ? (
                    <p className="px-1 pb-2 text-xs text-fg-muted">{t.laneUsesTasks}</p>
                  ) : (
                    <p className="flex items-start gap-1 px-1 pb-2 text-xs text-warn">
                      <CircleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
                      {t.laneEmpty}
                    </p>
                  )
                ) : (
                  <ol aria-label={t[`lane_${lane}`]} className="mb-2 flex flex-col gap-1">
                    {chain.map((ref, i) => {
                      const { provider, model } = splitRef(ref);
                      const p = providers.find((x) => x.id === provider);
                      const broken = !p || !p.enabled;
                      return (
                        <li key={ref} className={cn("flex min-h-10 items-center gap-2 rounded-lg border border-line ps-2", broken && "border-danger/50")}>
                          <span
                            title={i === 0 ? t.primary : t.fallback(i)}
                            className={cn(
                              "grid size-6 shrink-0 place-items-center rounded-full text-[0.6875rem] font-semibold tabular-nums",
                              i === 0 ? "bg-accent text-accent-fg" : "bg-subtle text-fg-muted",
                            )}
                          >
                            <span aria-hidden>{i + 1}</span>
                            <span className="sr-only">{i === 0 ? t.primary : t.fallback(i)}</span>
                          </span>
                          <span className="flex min-w-0 flex-1 flex-col py-1 leading-tight">
                            <span className="truncate text-xs text-fg-muted" title={p?.label ?? provider}>
                              {p?.label ?? provider}
                            </span>
                            <span className="truncate font-mono text-xs" title={model}>
                              {model}
                            </span>
                          </span>
                          {broken && <CircleAlert role="img" aria-label={t.providerMissing} className="size-4 shrink-0 text-danger" />}
                          <div className="flex shrink-0">
                            <IconButton label={`${t.moveUp}: ${ref}`} size="icon-sm" disabled={i === 0} onClick={() => update(lane, move(chain, i, -1))}>
                              <ArrowUp aria-hidden />
                            </IconButton>
                            <IconButton label={`${t.moveDown}: ${ref}`} size="icon-sm" disabled={i === chain.length - 1} onClick={() => update(lane, move(chain, i, 1))}>
                              <ArrowDown aria-hidden />
                            </IconButton>
                            <IconButton label={`${t.remove}: ${ref}`} size="icon-sm" onClick={() => update(lane, chain.filter((r) => r !== ref))}>
                              <X aria-hidden />
                            </IconButton>
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                )}
                <div className="mt-auto">
                  <ComboboxAdd
                    aria-label={`${t.addFallback}: ${t[`lane_${lane}`]}`}
                    placeholder={t.addFallback}
                    items={refs.filter((r) => !chain.includes(r))}
                    mono
                    emptyText={refs.length ? t.noResults : t.noModels}
                    onAdd={(ref) => update(lane, [...chain, ref])}
                  />
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </Section>
  );
}

function move<T>(list: T[], i: number, by: -1 | 1): T[] {
  const next = list.slice();
  const j = i + by;
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
}
