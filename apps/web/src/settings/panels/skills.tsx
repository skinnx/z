/** Skills: instructions the owner writes once and runs with `/name`, each with the tools it may use. */
import type { Skill } from "@z/core";
import { Form } from "@base-ui/react/form";
import { Check, Pencil, Plus, SquareSlash, Trash2, Wrench, X } from "lucide-react";
import { useMemo, useState } from "react";
import { useConnectors } from "../../api/connectors.ts";
import { usePlugins } from "../../api/plugins.ts";
import { useDeleteSkill, useSaveSkill, useSkills } from "../../api/skills.ts";
import { useT } from "../../i18n.ts";
import { cn } from "../../lib/cn.ts";
import { Confirm } from "../../ui/alert-dialog.tsx";
import { Button } from "../../ui/button.tsx";
import { Empty, Loading, LoadError, Spinner } from "../../ui/card.tsx";
import { ComboboxAdd } from "../../ui/combobox.tsx";
import { Dialog } from "../../ui/dialog.tsx";
import { Field, Input, Textarea } from "../../ui/field.tsx";
import { IconButton } from "../../ui/icon-button.tsx";
import { notify, notifyError } from "../../ui/toast.tsx";

const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX_INSTRUCTIONS = 8000;

/** Every tool name z offers right now, plus one `<source>_*` glob per plugin and connector. */
function useToolChoices() {
  const t = useT();
  const plugins = usePlugins();
  const connectors = useConnectors();
  return useMemo(() => {
    const names: string[] = [];
    const globs: { pattern: string; label: string }[] = [];
    for (const p of plugins.data ?? []) {
      if (!p.enabled || p.tools.length === 0) continue;
      globs.push({ pattern: `${p.id}_*`, label: t.skillAllOf(p.name) });
      names.push(...p.tools.map((tool) => `${p.id}_${tool.name}`));
    }
    for (const c of connectors.data ?? []) {
      if (!c.enabled || c.tools.length === 0) continue;
      globs.push({ pattern: `mcp_${c.id}_*`, label: t.skillAllOf(c.label) });
      names.push(...c.tools.map((tool) => tool.toolName));
    }
    return { names, globs, items: [...globs.map((g) => g.pattern), ...names], loaded: plugins.isSuccess && connectors.isSuccess };
  }, [plugins.data, connectors.data, plugins.isSuccess, connectors.isSuccess, t]);
}

const matches = (pattern: string, names: string[]) => {
  const re = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
  return names.filter((n) => re.test(n)).length;
};

export function SkillsPanel() {
  const t = useT();
  const skills = useSkills();
  const [editing, setEditing] = useState<Skill | "new" | null>(null);

  return (
    <div className="flex flex-col gap-3 pt-2">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" size="sm" onClick={() => setEditing("new")}>
          <Plus aria-hidden />
          {t.addSkill}
        </Button>
        <p className="min-w-0 flex-1 basis-60 text-xs text-fg-muted">{t.skillsHint}</p>
      </div>
      {skills.isPending ? (
        <Loading label={t.loading} className="h-24" />
      ) : skills.error ? (
        <LoadError error={skills.error} onRetry={() => void skills.refetch()} retryLabel={t.retry} />
      ) : skills.data.length === 0 ? (
        <Empty icon={<SquareSlash />} text={t.noSkillsYet} />
      ) : (
        <ul className="divide-y divide-line rounded-(--radius-card) border border-line">
          {skills.data.map((s) => (
            <SkillRow key={s.id} skill={s} onEdit={() => setEditing(s)} />
          ))}
        </ul>
      )}
      <Dialog.Root open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <Dialog.Content wide title={editing === "new" ? t.addSkill : t.editSkill}>
          {editing !== null && <SkillEditor skill={editing === "new" ? undefined : editing} onDone={() => setEditing(null)} />}
        </Dialog.Content>
      </Dialog.Root>
    </div>
  );
}

function SkillRow({ skill, onEdit }: { skill: Skill; onEdit: () => void }) {
  const t = useT();
  const remove = useDeleteSkill();
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <SquareSlash aria-hidden className="mt-0.5 size-4 shrink-0 text-fg-muted" />
      <div className="min-w-0 flex-1">
        <p className="font-mono text-sm font-medium">/{skill.name}</p>
        <p className="mt-0.5 text-sm text-fg-muted">{skill.description}</p>
        <p className="mt-1.5 flex items-start gap-1.5 text-xs text-fg-muted">
          <Wrench aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <span className="sr-only">{t.skillTools}: </span>
          <span className={cn("min-w-0 break-words", skill.tools.length > 0 && "font-mono")}>
            {skill.tools.length ? skill.tools.join(", ") : t.skillAllTools}
          </span>
        </p>
      </div>
      <div className="flex shrink-0 items-center">
        <IconButton label={`${t.editSkill}: /${skill.name}`} onClick={onEdit}>
          <Pencil aria-hidden />
        </IconButton>
        <Confirm
          trigger={
            <Button variant="ghost" size="icon" aria-label={`${t.deleteSkill}: /${skill.name}`} title={t.deleteSkill}>
              <Trash2 aria-hidden />
            </Button>
          }
          title={t.deleteSkillConfirm(skill.name)}
          confirmLabel={t.delete}
          onConfirm={() => remove.mutateAsync(skill.id).catch(notifyError)}
        />
      </div>
    </li>
  );
}

function SkillEditor({ skill, onDone }: { skill?: Skill; onDone: () => void }) {
  const t = useT();
  const save = useSaveSkill();
  const choices = useToolChoices();
  const [name, setName] = useState(skill?.name ?? "");
  const [description, setDescription] = useState(skill?.description ?? "");
  const [instructions, setInstructions] = useState(skill?.instructions ?? "");
  const [tools, setTools] = useState<string[]>(skill?.tools ?? []);
  const nameError = name && !NAME.test(name) ? t.skillNameInvalid : undefined;
  const canSave = NAME.test(name) && description.trim() && instructions.trim() && instructions.length <= MAX_INSTRUCTIONS && !save.isPending;

  const submit = () => {
    if (!canSave) return;
    save.mutate(
      { id: skill?.id, name, description: description.trim(), instructions: instructions.trim(), tools },
      {
        onSuccess: (saved) => {
          notify("success", t.skillSaved, `/${saved.name}`);
          onDone();
        },
        onError: notifyError,
      },
    );
  };

  return (
    <Form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="grid gap-4 sm:grid-cols-[minmax(0,14rem)_1fr]">
        <Field label={t.skillName} description={t.skillNameHint} error={nameError}>
          <div className="relative">
            <span aria-hidden className="pointer-events-none absolute start-3 top-2.5 font-mono text-fg-muted">
              /
            </span>
            <Input
              value={name}
              onValueChange={(v) => setName(v.toLowerCase().replace(/\s+/g, "-"))}
              placeholder="factcheck"
              spellCheck={false}
              autoCapitalize="off"
              maxLength={40}
              className="ps-6 font-mono text-sm"
            />
          </div>
        </Field>
        <Field label={t.skillDescription} description={t.skillDescriptionHint}>
          <Input value={description} onValueChange={setDescription} maxLength={200} />
        </Field>
      </div>
      <Field label={t.skillInstructions} description={t.skillInstructionsHint}>
        <Textarea value={instructions} onChange={(e) => setInstructions(e.currentTarget.value)} maxLength={MAX_INSTRUCTIONS} rows={7} className="text-sm" />
        <span className={cn("self-end text-xs tabular-nums", instructions.length > MAX_INSTRUCTIONS * 0.9 ? "text-warn" : "text-fg-muted")}>
          <span className="sr-only">{t.characters}: </span>
          {t.charCount(instructions.length, MAX_INSTRUCTIONS)}
        </span>
      </Field>
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">{t.skillTools}</legend>
        <p className="-mt-1 text-xs text-fg-muted">{t.skillToolsHint}</p>
        {tools.length > 0 ? (
          <ul className="flex flex-wrap gap-1.5">
            {tools.map((pattern) => {
              const glob = choices.globs.find((g) => g.pattern === pattern);
              const count = pattern.includes("*") ? matches(pattern, choices.names) : choices.names.includes(pattern) ? 1 : 0;
              const missing = choices.loaded && count === 0;
              return (
                <li key={pattern}>
                  <span
                    title={missing ? t.skillUnknownTool : glob?.label}
                    className={cn("inline-flex h-7 items-center gap-1 rounded-lg border ps-2 pe-0.5 text-[0.8125rem]", missing ? "border-warn/50 text-warn" : "border-line bg-subtle")}
                  >
                    <span className="font-mono">{pattern}</span>
                    {pattern.includes("*") && <span className="text-xs text-fg-muted">· {t.skillToolCount(count)}</span>}
                    <button
                      type="button"
                      aria-label={t.removeTool(pattern)}
                      onClick={() => setTools(tools.filter((x) => x !== pattern))}
                      className="grid size-6 place-items-center rounded-md hover:bg-line focus-visible:outline-2 focus-visible:outline-accent"
                    >
                      <X aria-hidden className="size-3.5" />
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-sm text-fg-muted">{t.skillAllTools}</p>
        )}
        <ComboboxAdd
          aria-label={t.skillToolsAdd}
          placeholder={t.skillToolsAdd}
          items={choices.items.filter((x) => !tools.includes(x))}
          emptyText={t.skillToolsEmpty}
          mono
          onAdd={(v) => setTools([...tools, v])}
        />
      </fieldset>
      <div className="flex justify-end gap-2 border-t border-line pt-4">
        <Button variant="ghost" onClick={onDone}>
          {t.cancel}
        </Button>
        <Button type="submit" variant="primary" disabled={!canSave}>
          {save.isPending ? <Spinner /> : <Check aria-hidden />}
          {t.save}
        </Button>
      </div>
    </Form>
  );
}
