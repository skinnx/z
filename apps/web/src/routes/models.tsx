import type { Lane, ModelRef, ProviderInput, ProviderView, Routing } from "@z/core";
import { ArrowDown, ArrowUp, Check, CircleAlert, CircleCheck, Gift, LockKeyhole, Pencil, Plus, Route, Trash2, X, Zap } from "lucide-react";
import { Form } from "@base-ui/react/form";
import { useEffect, useId, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import {
  LANES,
  useDeleteProvider,
  useModelRefs,
  useProviderModels,
  useProviders,
  useRouting,
  useSaveProvider,
  useSaveRouting,
  useTestProvider,
  type ProviderTest,
} from "../api/providers.ts";
import { useT } from "../i18n.ts";
import { cn } from "../lib/cn.ts";
import { compact, slug, usd } from "../lib/format.ts";
import { laneIcon } from "../lib/icons.tsx";
import { LLM7_ROUTING, PRESETS, presetFor, splitRef, type ProviderPreset } from "../lib/models.ts";
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

export default function Models() {
  const t = useT();
  const providers = useProviders();
  const [params, setParams] = useSearchParams();
  const [editing, setEditing] = useState<ProviderView | "new" | null>(null);

  useEffect(() => {
    if (params.has("add")) {
      setEditing("new");
      setParams({}, { replace: true });
    }
  }, [params, setParams]);

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
        <FirstRun />
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
                <ProviderCard key={p.id} provider={p} onEdit={() => setEditing(p)} />
              ))}
            </div>
          </Section>
          <RoutingEditor />
        </>
      )}

      <Dialog.Root open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <Dialog.Content title={editing === "new" || editing === null ? t.addProvider : editing.label} wide>
          {editing !== null && (
            <ProviderForm
              key={editing === "new" ? "new" : editing.id}
              provider={editing === "new" ? null : editing}
              onSaved={(p) => setEditing(p)}
              onDeleted={() => setEditing(null)}
            />
          )}
        </Dialog.Content>
      </Dialog.Root>
    </Page>
  );
}

/** No providers yet: one tap to a working setup, or bring your own key right here. */
function FirstRun() {
  const t = useT();
  const save = useSaveProvider();
  const routing = useSaveRouting();
  const llm7 = PRESETS.find((p) => p.key === "llm7")!;

  const startFree = () =>
    save.mutate(
      { id: llm7.id, kind: llm7.kind, label: llm7.label, baseURL: llm7.baseURL, models: llm7.models ?? [], enabled: true },
      {
        onSuccess: () =>
          routing.mutate(LLM7_ROUTING, {
            onSuccess: () => notify("success", t.saved, "LLM7"),
            onError: notifyError,
          }),
        onError: notifyError,
      },
    );

  return (
    <div className="flex flex-col gap-6">
      <Tile
        onClick={startFree}
        disabled={save.isPending || routing.isPending}
        className="gap-4! rounded-(--radius-card)! border-accent/50! bg-accent-soft! p-5! hover:border-accent!"
      >
        <span className="grid size-12 shrink-0 place-items-center rounded-xl bg-accent text-accent-fg">
          {save.isPending || routing.isPending ? <Spinner /> : <Zap aria-hidden className="size-6" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-base font-semibold">{t.startFree}</span>
          <span className="block text-sm text-fg-muted">{t.startFreeMeta}</span>
        </span>
        <ArrowUp aria-hidden className="size-5 shrink-0 rotate-45 text-accent-text rtl:-rotate-45" />
      </Tile>
      <div className="flex items-center gap-3 text-xs text-fg-muted">
        <span className="h-px flex-1 bg-line" />
        {t.orBringKey}
        <span className="h-px flex-1 bg-line" />
      </div>
      <Card className="p-5">
        <ProviderForm provider={null} defaultPreset="openai" onSaved={() => {}} onDeleted={() => {}} />
      </Card>
    </div>
  );
}

function ProviderCard({ provider: p, onEdit }: { provider: ProviderView; onEdit: () => void }) {
  const t = useT();
  const test = useTestProvider();
  const save = useSaveProvider();
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
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-muted">
            <span className="flex items-center gap-1">
              <LockKeyhole aria-hidden className="size-3.5" />
              {p.hasKey ? <span className="font-mono">••••{p.keyHint}</span> : t.noKey}
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
            <span className="text-fg tabular-nums">
              {usd(p.usage.monthUsd)} · {t.tokens(compact(p.usage.monthTokens))}
            </span>
          </p>
        )}
        <TestResult result={test.data} error={test.error} pending={test.isPending} />
      </div>

      <div className="flex items-center gap-1 @xl:ms-2">
        <Button size="sm" onClick={() => test.mutate(p.id)} disabled={test.isPending || !p.enabled}>
          {test.isPending ? <Spinner /> : <Zap aria-hidden />}
          {test.isPending ? t.testing : t.test}
        </Button>
        <IconButton label={`${t.edit}: ${p.label}`} size="icon-sm" onClick={onEdit}>
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

function TestResult({ result, error, pending }: { result?: ProviderTest; error: Error | null; pending: boolean }) {
  const t = useT();
  const msg = error?.message ?? (result && !result.ok ? result.error : null);
  return (
    <p aria-live="polite" className="min-h-4 text-xs">
      {pending ? null : msg ? (
        <span className="flex items-start gap-1 text-danger">
          <CircleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
          <span className="line-clamp-3 break-words">{msg}</span>
        </span>
      ) : result?.ok ? (
        <span className="flex items-center gap-1 text-ok">
          <CircleCheck aria-hidden className="size-3.5 shrink-0" />
          {t.testOk(result.latencyMs ?? 0, result.model ?? "")}
        </span>
      ) : null}
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
    ...patch,
  };
}

function ProviderForm({
  provider,
  onSaved,
  onDeleted,
  defaultPreset = "llm7",
}: {
  defaultPreset?: string;
  provider: ProviderView | null;
  onSaved: (p: ProviderView) => void;
  onDeleted: () => void;
}) {
  const t = useT();
  const formId = useId();
  const save = useSaveProvider();
  const remove = useDeleteProvider();
  const test = useTestProvider();
  const existing = useProviders().data ?? [];
  const [preset, setPreset] = useState<ProviderPreset>(() => (provider ? presetFor(provider.kind, provider.baseURL) : PRESETS.find((p) => p.key === defaultPreset) ?? PRESETS[0]!));
  const [label, setLabel] = useState(provider?.label ?? preset.label);
  const [id, setId] = useState(provider?.id ?? uniqueId(preset.id, existing));
  const [idTouched, setIdTouched] = useState(false);
  const [baseURL, setBaseURL] = useState(provider?.baseURL ?? (preset.fixedBaseURL ? preset.baseURL ?? "" : ""));
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState<string[]>(provider?.models ?? preset.models ?? []);
  const [budget, setBudget] = useState<number | null>(provider?.monthlyBudgetUsd ?? null);
  const [enabled, setEnabled] = useState(provider?.enabled ?? true);
  const live = useProviderModels(provider?.id ?? null);

  const choosePreset = (key: string) => {
    const next = PRESETS.find((p) => p.key === key)!;
    setPreset(next);
    setLabel(next.label);
    if (!idTouched) setId(uniqueId(next.id, existing));
    setBaseURL(next.fixedBaseURL ? next.baseURL ?? "" : "");
    setModels(next.models ?? []);
  };

  const urlRequired = preset.kind === "openai-compatible";
  const idValid = /^[a-z0-9][a-z0-9-]{0,31}$/.test(id);
  const idTaken = !provider && existing.some((p) => p.id === id);
  const suggestions = useMemo(() => (live.data ?? []).filter((m) => !models.includes(m)), [live.data, models]);

  const submit = () => {
    if (!idValid || idTaken) return;
    const input: ProviderInput = {
      id,
      kind: preset.kind,
      label: label.trim() || preset.label,
      ...(baseURL.trim() ? { baseURL: baseURL.trim() } : {}),
      ...(apiKey ? { apiKey } : {}),
      ...(provider?.headers ? { headers: provider.headers } : {}),
      ...(provider?.contextWindows ? { contextWindows: provider.contextWindows } : {}),
      models,
      enabled,
      ...(budget !== null ? { monthlyBudgetUsd: budget } : {}),
    };
    save.mutate(input, {
      onSuccess: (p) => {
        setApiKey("");
        notify("success", t.saved, p.label);
        onSaved(p);
      },
      onError: notifyError,
    });
  };

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
          options={PRESETS.map((p) => ({
            value: p.key,
            title: p.label,
            meta: p.free ? t.freeNoKey : p.needsKey ? undefined : t.noKeyNeeded,
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

      <Field label={t.apiKey} description={provider?.hasKey ? `${t.keepSecret} ••••${provider.keyHint ?? ""}` : `${preset.needsKey ? `${t.keyNeeded} ` : ""}${t.keyStaysHere}`}>
        <div className="flex gap-2">
          <Input
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

      {/* min-w-0: a fieldset is min-content wide by default, so one long model id would widen the dialog. */}
      <fieldset className="flex min-w-0 flex-col gap-2">
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
        {!provider && <p className="text-xs text-fg-muted">{t.saveToLoadModels}</p>}
        {provider && live.error && <p className="text-xs break-words text-fg-muted">{live.error.message}</p>}
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
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
        <div className="flex items-end">
          <div className="w-full">
            <SwitchRow label={t.enabled} checked={enabled} onCheckedChange={setEnabled} />
          </div>
        </div>
      </div>

      {provider && <TestResult result={test.data} error={test.error} pending={test.isPending} />}

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
          <Button type="submit" variant="primary" disabled={save.isPending || !idValid || idTaken}>
            {save.isPending ? <Spinner /> : provider ? <Check aria-hidden /> : <Plus aria-hidden />}
            {provider ? t.save : t.addProvider}
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

function RoutingEditor() {
  const t = useT();
  const routing = useRouting();
  const save = useSaveRouting();
  const refs = useModelRefs();
  const providers = useProviders().data ?? [];
  const current = routing.data;

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
              <Card key={lane} className="flex min-w-0 flex-col p-3">
                <h3 className="flex items-center gap-2 px-1 pb-2 text-sm font-semibold">
                  <Icon aria-hidden className="size-4 text-fg-muted" />
                  {t[`lane_${lane}`]}
                </h3>
                {chain.length === 0 ? (
                  <p className="px-1 pb-2 text-xs text-fg-muted">{t.laneEmpty}</p>
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
