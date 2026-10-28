/** What z knows about its owner: search, add, correct or forget. Never shown to channel bots. */
import type { Memory } from "@z/core";
import { Form } from "@base-ui/react/form";
import { Bot, Brain, Check, Pencil, Plus, Search, Trash2, X } from "lucide-react";
import { useState } from "react";
import { useDeleteMemory, useMemories, useSaveMemory } from "../../api/memories.ts";
import { useT } from "../../i18n.ts";
import { relativeTime } from "../../lib/format.ts";
import { Confirm } from "../../ui/alert-dialog.tsx";
import { Button } from "../../ui/button.tsx";
import { Badge, Empty, Loading, LoadError, Spinner } from "../../ui/card.tsx";
import { Field, Input, Textarea } from "../../ui/field.tsx";
import { IconButton } from "../../ui/icon-button.tsx";
import { notifyError } from "../../ui/toast.tsx";

const SEARCH_FROM = 6;

export function MemoryManager() {
  const t = useT();
  const memories = useMemories();
  const [query, setQuery] = useState("");
  const list = memories.data ?? [];
  const q = query.trim().toLowerCase();
  const shown = q ? list.filter((m) => m.text.toLowerCase().includes(q)) : list;

  return (
    <div className="flex flex-col gap-4">
      <MemoryEditor />
      {memories.isPending ? (
        <Loading label={t.loading} />
      ) : memories.error && !memories.data ? (
        <LoadError error={memories.error} onRetry={() => void memories.refetch()} retryLabel={t.retry} />
      ) : list.length === 0 ? (
        <Empty icon={<Brain />} text={t.noMemories} />
      ) : (
        <section aria-label={t.memories} className="flex flex-col gap-2">
          {list.length > SEARCH_FROM && (
            <div className="relative">
              <Search aria-hidden className="pointer-events-none absolute start-3 top-3 size-4 text-fg-muted" />
              <Input type="search" aria-label={t.searchMemories} placeholder={t.searchMemories} value={query} onValueChange={setQuery} className="ps-9" />
            </div>
          )}
          {shown.length === 0 ? (
            <p className="px-1 py-4 text-sm text-fg-muted">{t.noResults}</p>
          ) : (
            <ul className="divide-y divide-line rounded-(--radius-card) border border-line">
              {shown.map((m) => (
                <MemoryRow key={m.id} memory={m} />
              ))}
            </ul>
          )}
          <p className="px-1 text-xs text-fg-muted">{t.memoryPrivate}</p>
        </section>
      )}
    </div>
  );
}

/** Add (or edit, when `memory` is given) one memory. */
function MemoryEditor({ memory, onDone }: { memory?: Memory; onDone?: () => void }) {
  const t = useT();
  const save = useSaveMemory();
  const [text, setText] = useState(memory?.text ?? "");
  const canSave = text.trim().length > 0 && text.trim() !== memory?.text && !save.isPending;

  function submit() {
    if (!canSave) return;
    save.mutate(
      { id: memory?.id, text: text.trim() },
      {
        onSuccess: () => {
          if (!memory) setText("");
          onDone?.();
        },
        onError: notifyError,
      },
    );
  }

  return (
    <Form
      aria-label={memory ? t.editMemory : t.addMemory}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className={memory ? "flex flex-col gap-2" : "rounded-(--radius-card) border border-line bg-surface focus-within:border-line-strong"}
    >
      <Field label={memory ? t.editMemory : t.addMemory} srOnlyLabel className="gap-0">
        <Textarea
          autoFocus={!!memory}
          value={text}
          maxLength={2000}
          rows={2}
          onChange={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
            if (e.key === "Escape" && memory) {
              // Cancel the edit, not the whole dialog.
              e.stopPropagation();
              onDone?.();
            }
          }}
          placeholder={t.memoryPlaceholder}
          className={memory ? "min-h-16 text-sm" : "min-h-16 rounded-b-none border-0 bg-transparent px-4 pt-3 text-[0.9375rem] focus-visible:outline-none"}
        />
      </Field>
      <div className={memory ? "flex justify-end gap-2" : "flex items-center justify-end gap-2 border-t border-line px-3 py-2"}>
        {memory && (
          <Button size="sm" variant="ghost" onClick={onDone}>
            <X aria-hidden />
            {t.cancel}
          </Button>
        )}
        <Button type="submit" size="sm" variant="primary" disabled={!canSave}>
          {save.isPending ? <Spinner /> : memory ? <Check aria-hidden /> : <Plus aria-hidden />}
          {memory ? t.save : t.remember}
        </Button>
      </div>
    </Form>
  );
}

function MemoryRow({ memory }: { memory: Memory }) {
  const t = useT();
  const remove = useDeleteMemory();
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <li className="px-4 py-3">
        <MemoryEditor memory={memory} onDone={() => setEditing(false)} />
      </li>
    );
  }

  return (
    <li className="flex items-start gap-2 py-2 ps-4 pe-2">
      <div className="min-w-0 flex-1 py-1.5">
        <p className="text-sm leading-relaxed break-words whitespace-pre-wrap">{memory.text}</p>
        <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-fg-muted">
          {memory.source === "agent" ? (
            <Badge tone="accent" className="h-5">
              <Bot aria-hidden />
              {t.memoryByAgent}
            </Badge>
          ) : (
            <span className="sr-only">{t.memoryByYou}</span>
          )}
          <time dateTime={memory.updatedAt}>{relativeTime(memory.updatedAt)}</time>
        </p>
      </div>
      <IconButton label={t.edit} size="icon-sm" onClick={() => setEditing(true)}>
        <Pencil aria-hidden />
      </IconButton>
      <Confirm
        trigger={
          <IconButton label={t.forget} size="icon-sm" className="hover:text-danger">
            <Trash2 aria-hidden />
          </IconButton>
        }
        title={t.forgetConfirm}
        confirmLabel={t.forget}
        onConfirm={() => remove.mutateAsync(memory.id).then(() => undefined, notifyError)}
      />
    </li>
  );
}
