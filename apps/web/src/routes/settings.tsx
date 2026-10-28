import type { PluginManifest, Risk, Settings as SettingsT } from "@z/core";
import { Form } from "@base-ui/react/form";
import { AtSign, Check, Clock, KeyRound, Languages, Monitor, Moon, ShieldCheck, Sun, UserRound } from "lucide-react";
import { useMemo, useState } from "react";
import { token } from "../api/client.ts";
import { useConnectors } from "../api/connectors.ts";
import { usePlugins } from "../api/plugins.ts";
import { ReachSettings } from "../components/reach-settings.tsx";
import { effectivePolicy, PolicyControl, type Policy } from "../components/tool-policy.tsx";
import { useSaveSettings, useSettings } from "../api/settings.ts";
import { locale, useT, type Locale } from "../i18n.ts";
import { parseCron } from "../lib/cron.ts";
import { RiskIcon } from "../lib/icons.tsx";
import { theme, type ThemePref } from "../lib/theme.ts";
import { Button } from "../ui/button.tsx";
import { Card, Loading, LoadError, Section, Spinner } from "../ui/card.tsx";
import { Combobox } from "../ui/combobox.tsx";
import { Field, Input, Textarea } from "../ui/field.tsx";
import { Select } from "../ui/select.tsx";
import { notify, notifyError } from "../ui/toast.tsx";
import { Segmented } from "../ui/toggle-group.tsx";

export default function Settings() {
  const t = useT();
  const settings = useSettings();
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-10 px-4 py-6 md:px-8 md:py-10">
      <h1 className="sr-only">{t.nav_settings}</h1>
      {settings.data ? (
        // Keyed without the owner: pairing elsewhere must not reset unsaved edits here.
        <AgentSettings key={JSON.stringify({ ...settings.data, owner: null })} initial={settings.data} />
      ) : settings.error ? (
        <LoadError error={settings.error} onRetry={() => void settings.refetch()} retryLabel={t.retry} />
      ) : (
        <Loading label={t.loading} />
      )}
      <ReachSettings />
      <DeviceSettings />
    </div>
  );
}

type PolicyTool = { key: string; name: string; source: string; risk: Risk; defaultPolicy?: Policy };

function AgentSettings({ initial }: { initial: SettingsT }) {
  const t = useT();
  const save = useSaveSettings();
  const plugins = usePlugins().data;
  const connectors = useConnectors().data;
  const [handle, setHandle] = useState(initial.handle);
  const [timezone, setTimezone] = useState<string | null>(initial.timezone);
  const parsed = parseCron(initial.briefingCron);
  const [briefTime, setBriefTime] = useState(parsed.time);
  const [cron, setCron] = useState(initial.briefingCron);
  const [persona, setPersona] = useState(initial.persona);
  const [policy, setPolicy] = useState<Record<string, Policy>>(initial.approvals);
  const zones = useMemo(() => {
    const list = Intl.supportedValuesOf("timeZone");
    return list.includes("UTC") ? list : ["UTC", ...list];
  }, []);
  const tools = useMemo<PolicyTool[]>(
    () => [
      ...(plugins ?? []).flatMap((p: PluginManifest) =>
        p.tools.map((tool) => ({ key: `${p.id}_${tool.name}`, name: tool.name, source: p.name, risk: tool.risk, defaultPolicy: tool.defaultPolicy })),
      ),
      ...(connectors ?? []).flatMap((c) => c.tools.map((tool) => ({ key: tool.toolName, name: tool.name, source: c.label, risk: tool.risk }))),
    ],
    [plugins, connectors],
  );
  const simple = parsed.preset !== "custom";

  return (
    <Form
      className="flex flex-col gap-10"
      onSubmit={(e) => {
        e.preventDefault();
        const [h = "7", m = "0"] = briefTime.split(":");
        save.mutate(
          {
            handle: handle.trim() || "z",
            timezone: timezone ?? "UTC",
            briefingCron: simple ? `${Number(m)} ${Number(h)} * * *` : cron.trim(),
            persona,
            approvals: policy,
          },
          { onSuccess: () => notify("success", t.saved), onError: notifyError },
        );
      }}
    >
      <Section label={t.agent} icon={<UserRound aria-hidden />}>
        <Card className="grid gap-5 p-5 sm:grid-cols-2">
          <Field label={t.handle} description={t.handleHint(handle || "z")}>
            <div className="relative">
              <AtSign aria-hidden className="pointer-events-none absolute start-3 top-3 size-4 text-fg-muted" />
              <Input required value={handle} onValueChange={setHandle} maxLength={32} className="ps-9" spellCheck={false} />
            </div>
          </Field>
          <Field label={t.timezone}>
            <Combobox items={zones} value={timezone} onChange={setTimezone} emptyText={t.noResults} placeholder="UTC" />
          </Field>
          <Field label={t.briefingTime}>
            {simple ? (
              <div className="relative">
                <Clock aria-hidden className="pointer-events-none absolute start-3 top-3 size-4 text-fg-muted" />
                <Input type="time" required value={briefTime} onValueChange={setBriefTime} className="ps-9" />
              </div>
            ) : (
              <Input value={cron} onValueChange={setCron} className="font-mono text-sm" spellCheck={false} />
            )}
          </Field>
          <Field label={t.persona} className="sm:col-span-2">
            <Textarea value={persona} onChange={(e) => setPersona(e.currentTarget.value)} placeholder={t.personaPlaceholder} maxLength={4000} rows={4} />
          </Field>
        </Card>
      </Section>

      <Section label={t.approvalPolicy} icon={<ShieldCheck aria-hidden />}>
        {tools.length === 0 ? (
          <p className="text-sm text-fg-muted">{t.noTools}</p>
        ) : (
          <Card>
            <ul className="divide-y divide-line">
              {tools.map((tool) => (
                <li key={tool.key} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <RiskIcon risk={tool.risk} t={t} />
                  <span className="min-w-0 flex-1">
                    <code className="block truncate font-mono text-sm">{tool.name}</code>
                    <span className="block truncate text-xs text-fg-muted">{tool.source}</span>
                  </span>
                  <PolicyControl
                    toolKey={tool.key}
                    risk={tool.risk}
                    value={effectivePolicy(tool.risk, policy[tool.key], tool.defaultPolicy)}
                    onChange={(v) => setPolicy((p) => ({ ...p, [tool.key]: v }))}
                  />
                </li>
              ))}
            </ul>
          </Card>
        )}
      </Section>

      <div className="sticky bottom-20 z-10 flex justify-end md:bottom-4">
        <Button type="submit" variant="primary" disabled={save.isPending} className="shadow-lg">
          {save.isPending ? <Spinner /> : <Check aria-hidden />}
          {t.save}
        </Button>
      </div>
    </Form>
  );
}

function DeviceSettings() {
  const t = useT();
  const lang = locale.use();
  const pref = theme.use();
  const stored = token.use();
  const [draft, setDraft] = useState("");

  return (
    <Section label={t.appearance} icon={<Monitor aria-hidden />}>
      <Card className="grid gap-5 p-5 sm:grid-cols-2">
        <Field label={t.language}>
          <Select<Locale>
            value={lang}
            onChange={(v) => locale.set(v)}
            options={[
              { value: "en", label: "English", icon: <Languages aria-hidden /> },
              { value: "vi", label: "Tiếng Việt", icon: <Languages aria-hidden /> },
            ]}
          />
        </Field>
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium" aria-hidden>
            {t.theme}
          </span>
          <Segmented<ThemePref>
            label={t.theme}
            value={pref}
            onChange={(v) => theme.set(v === "system" ? null : v)}
            className="h-10 w-full"
            options={[
              { value: "system", label: t.th_system, icon: <Monitor aria-hidden /> },
              { value: "light", label: t.th_light, icon: <Sun aria-hidden /> },
              { value: "dark", label: t.th_dark, icon: <Moon aria-hidden /> },
            ]}
          />
        </div>
        <Form
          className="flex flex-col gap-2 sm:col-span-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!draft.trim()) return;
            token.set(draft.trim());
            setDraft("");
            notify("success", t.saved);
          }}
        >
          <Field label={t.apiToken} description={stored ? t.tokenStored : t.tokenOptional}>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <KeyRound aria-hidden className="pointer-events-none absolute start-3 top-3 size-4 text-fg-muted" />
                <Input type="password" autoComplete="off" value={draft} onValueChange={setDraft} placeholder={stored ? "••••••••" : "Z_TOKEN"} className="ps-9 font-mono text-sm" />
              </div>
              <Button type="submit" disabled={!draft.trim()}>
                {t.save}
              </Button>
              {stored && (
                <Button variant="danger" onClick={() => token.set(null)}>
                  {t.clearToken}
                </Button>
              )}
            </div>
          </Field>
        </Form>
      </Card>
    </Section>
  );
}
