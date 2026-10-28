/**
 * The `/` skill menu for a PromptInput: type `/` at the start and a Base UI Autocomplete lists the
 * owner's skills; arrow keys move, Enter or a click picks one and it becomes a chip above the text.
 * Typing a whole name and a space (`/factcheck `) makes the chip too. While the menu is closed every
 * key goes to the textarea as usual (Home/End and arrows move the caret, Enter sends), and nothing
 * happens mid-composition (IME: Vietnamese Telex, CJK…).
 */
import { Autocomplete } from "@base-ui/react/autocomplete";
import type { Skill } from "@z/core";
import { Settings2, SquareSlash, X } from "lucide-react";
import { useState, type ComponentProps, type Ref } from "react";
import { useSkills } from "../api/skills.ts";
import { useT } from "../i18n.ts";
import { cn } from "../lib/cn.ts";
import { useSettingsRoute } from "../settings/route.ts";
import { itemClass, popupClass } from "../ui/popup.ts";
import { PromptInputHeader, PromptInputTextarea, type PromptInputTextareaProps } from "./ai-elements/prompt-input.tsx";

/** The text a message is sent as: `/name rest` with a chip, the text alone without. */
export const withSkill = (skill: Skill | null, text: string) => (skill ? `/${skill.name} ${text.trim()}`.trim() : text.trim());

/** `/query` while it is the only thing typed. */
const slashQuery = (text: string) => /^\/([a-z0-9-]*)$/i.exec(text)?.[1]?.toLowerCase() ?? null;

export type SkillTextareaProps = Omit<PromptInputTextareaProps, "value" | "onChange"> & {
  value: string;
  onValueChange: (value: string) => void;
  skill: Skill | null;
  onSkillChange: (skill: Skill | null) => void;
  ref?: ComponentProps<"textarea">["ref"];
};

export function SkillTextarea({ value, onValueChange, skill, onSkillChange, ref, ...textarea }: SkillTextareaProps) {
  const t = useT();
  const skills = useSkills();
  const settings = useSettingsRoute();
  const [composing, setComposing] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const query = skill || composing ? null : slashQuery(value);
  const list = skills.data ?? [];
  const matches = query === null ? [] : list.filter((s) => s.name.includes(query) || s.description.toLowerCase().includes(query)).sort((a, b) => Number(!b.name.startsWith(query)) - Number(!a.name.startsWith(query)));
  const open = query !== null && dismissed !== value && skills.isSuccess;

  const pick = (next: Skill) => {
    onSkillChange(next);
    onValueChange("");
  };

  const change = (next: string) => {
    if (dismissed !== null && dismissed !== next) setDismissed(null);
    // A whole name and a space becomes the chip.
    const typed = !skill && !composing ? /^\/([a-z0-9-]+)\s([\s\S]*)$/.exec(next) : null;
    const found = typed && list.find((s) => s.name === typed[1]);
    if (found) {
      onSkillChange(found);
      onValueChange(typed![2]!);
      return;
    }
    onValueChange(next);
  };

  return (
    <>
      {skill && (
        <PromptInputHeader>
          <span className="inline-flex h-7 max-w-full items-center gap-1 rounded-lg bg-accent-soft ps-2 pe-0.5 text-sm font-medium text-accent">
            <SquareSlash aria-hidden className="size-3.5 shrink-0" />
            <span className="truncate font-mono text-[0.8125rem]">{skill.name}</span>
            <button
              type="button"
              aria-label={t.removeSkill(skill.name)}
              onClick={() => onSkillChange(null)}
              className="grid size-6 place-items-center rounded-md hover:bg-accent/15 focus-visible:outline-2 focus-visible:outline-accent"
            >
              <X aria-hidden className="size-3.5" />
            </button>
          </span>
          <span className="sr-only" aria-live="polite">
            {t.skillChosen(skill.name)}
          </span>
        </PromptInputHeader>
      )}
      <Autocomplete.Root
        items={matches}
        filter={null}
        open={open}
        onOpenChange={(next) => {
          if (!next && query !== null) setDismissed(value);
        }}
        value={value}
        onValueChange={(next, details) => {
          if (details.reason === "item-press") {
            const chosen = list.find((s) => `/${s.name}` === next);
            if (chosen) return pick(chosen);
          }
          change(next);
        }}
        itemToStringValue={(s: Skill) => `/${s.name}`}
        autoHighlight="always"
        keepHighlight
      >
        <Autocomplete.Input
          ref={ref as Ref<HTMLInputElement> | undefined}
          onKeyDown={(e) => {
            // Closed (or Home/End in a multi-line box): the textarea's own keys, not the list's.
            if (!open || e.key === "Home" || e.key === "End") e.preventBaseUIHandler();
            if (open && e.key === "Escape") {
              e.preventBaseUIHandler();
              e.preventDefault();
              e.stopPropagation();
              setDismissed(value);
            }
            // Backspace at the very start drops the chip.
            if (skill && e.key === "Backspace" && e.currentTarget.selectionStart === 0 && e.currentTarget.selectionEnd === 0) onSkillChange(null);
          }}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={() => setComposing(false)}
          render={<PromptInputTextarea {...textarea} />}
        />
        <Autocomplete.Portal>
          <Autocomplete.Positioner side="top" align="start" sideOffset={6} className="z-50">
            <Autocomplete.Popup aria-label={t.skills} className={cn(popupClass, "w-[min(24rem,var(--anchor-width))] min-w-0")}>
              <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-1.5 text-xs font-medium text-fg-muted">
                <span>{t.skills}</span>
                <button
                  type="button"
                  // Keep focus in the textarea until the click lands.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => settings.open("skills")}
                  className="inline-flex items-center gap-1 rounded px-1 hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
                >
                  <Settings2 aria-hidden className="size-3.5" />
                  {t.manageSkills}
                </button>
              </div>
              <Autocomplete.Empty className="px-3 py-3 text-sm text-fg-muted empty:hidden">{list.length ? t.noSkillMatch : t.noSkillsYet}</Autocomplete.Empty>
              <Autocomplete.List className="max-h-[min(18rem,var(--available-height))] overflow-y-auto p-1 empty:hidden">
                {(s: Skill) => (
                  <Autocomplete.Item key={s.id} value={s} className={cn(itemClass, "items-start py-2")}>
                    <SquareSlash aria-hidden className="mt-0.5 text-fg-muted" />
                    <span className="min-w-0 flex-1">
                      <span className="block font-mono text-[0.8125rem] font-medium">/{s.name}</span>
                      <span className="block truncate text-xs text-fg-muted">{s.description}</span>
                    </span>
                  </Autocomplete.Item>
                )}
              </Autocomplete.List>
            </Autocomplete.Popup>
          </Autocomplete.Positioner>
        </Autocomplete.Portal>
      </Autocomplete.Root>
    </>
  );
}
