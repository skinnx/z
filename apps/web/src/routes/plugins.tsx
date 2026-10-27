import type { PluginManifest } from "@z/core";
import { Form } from "@base-ui/react/form";
import { Blocks, Check, Sunrise } from "lucide-react";
import { useState } from "react";
import { usePlugins, useSavePlugin } from "../api/plugins.ts";
import { useT } from "../i18n.ts";
import { cn } from "../lib/cn.ts";
import { RiskIcon } from "../lib/icons.tsx";
import { Monogram } from "../ui/avatar.tsx";
import { Button } from "../ui/button.tsx";
import { Badge, Card, Empty, Loading, LoadError } from "../ui/card.tsx";
import { Disclosure } from "../ui/collapsible.tsx";
import { Field, Input } from "../ui/field.tsx";
import { Switch } from "../ui/switch.tsx";
import { notify, notifyError } from "../ui/toast.tsx";

export default function Plugins() {
  const t = useT();
  const plugins = usePlugins();

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6 md:px-8 md:py-10">
      <h1 className="sr-only">{t.nav_plugins}</h1>
      {plugins.isPending ? (
        <Loading label={t.loading} className="h-64" />
      ) : plugins.error && !plugins.data ? (
        <LoadError error={plugins.error} onRetry={() => void plugins.refetch()} retryLabel={t.retry} />
      ) : !plugins.data?.length ? (
        <Empty icon={<Blocks />} text={t.noPlugins} />
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {plugins.data.map((p) => (
            <li key={p.id}>
              <PluginCard plugin={p} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PluginCard({ plugin: p }: { plugin: PluginManifest }) {
  const t = useT();
  const save = useSavePlugin();
  const [values, setValues] = useState<Record<string, string>>({});
  const missing = p.settings.some((s) => s.required) && !p.enabled;

  return (
    <Card className={cn("flex h-full flex-col gap-3 p-4", !p.enabled && "bg-bg")}>
      <div className="flex items-start gap-3">
        <Monogram text={p.name} />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2 font-semibold">
            {p.name}
            {p.briefing && (
              <Badge>
                <Sunrise aria-hidden />
                {t.inBriefing}
              </Badge>
            )}
          </p>
          <p className="mt-0.5 text-sm text-fg-muted">{p.description}</p>
        </div>
        <Switch
          aria-label={`${t.enabled}: ${p.name}`}
          checked={p.enabled}
          disabled={save.isPending}
          onCheckedChange={(enabled) => save.mutate({ id: p.id, enabled }, { onError: notifyError })}
        />
      </div>

      {p.tools.length > 0 && (
        <ul aria-label={t.tools} className="flex flex-wrap gap-1.5">
          {p.tools.map((tool) => (
            <li key={tool.name} title={tool.description} className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-line px-2 font-mono text-xs">
              <RiskIcon risk={tool.risk} t={t} className="size-3.5" />
              {tool.name}
            </li>
          ))}
        </ul>
      )}

      {p.settings.length > 0 && (
        <Disclosure summary={t.pluginSettings} defaultOpen={missing} className="mt-auto">
          <Form
            className="flex flex-col gap-3 pt-2"
            onSubmit={(e) => {
              e.preventDefault();
              const typed = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== ""));
              save.mutate(
                { id: p.id, enabled: p.enabled, settings: typed },
                {
                  onSuccess: () => {
                    setValues({});
                    notify("success", t.saved, p.name);
                  },
                  onError: notifyError,
                },
              );
            }}
          >
            {p.settings.map((s) => (
              <Field key={s.key} label={s.label} description={s.secret ? t.blankKeeps : undefined}>
                <Input
                  type={s.secret ? "password" : "text"}
                  autoComplete="off"
                  value={values[s.key] ?? ""}
                  placeholder={s.required ? t.required : t.optional}
                  onValueChange={(v) => setValues((x) => ({ ...x, [s.key]: v }))}
                  spellCheck={false}
                />
              </Field>
            ))}
            <Button type="submit" size="sm" className="self-end" disabled={save.isPending || Object.values(values).every((v) => !v)}>
              <Check aria-hidden />
              {t.save}
            </Button>
          </Form>
        </Disclosure>
      )}
    </Card>
  );
}
