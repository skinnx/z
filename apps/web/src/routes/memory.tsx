import type { Memory } from "@z/core";
import { Form } from "@base-ui/react/form";
import { Bot, Brain, Check, Pencil, Plus, Trash2, UserRound, X } from "lucide-react";
import { useState } from "react";
import { useDeleteMemory, useMemories, useSaveMemory } from "../api/memories.ts";
import { useT } from "../i18n.ts";
import { relativeTime } from "../lib/format.ts";
import { Confirm } from "../ui/alert-dialog.tsx";
import { Button } from "../ui/button.tsx";
import { Card, Empty, Loading, LoadError, Spinner } from "../ui/card.tsx";
import { Field, Textarea } from "../ui/field.tsx";
import { IconButton } from "../ui/icon-button.tsx";
import { notifyError } from "../ui/toast.tsx";
import { Tooltip } from "../ui/tooltip.tsx";

/** What z knows about its owner: add, correct or forget. Never shown to channel bots. */
export default function MemoryRoute() {
  const t = useT();
  const memories = useMemories();

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6 md:px-8 md:py-10">
      <h1 className="sr-only">{t.nav_memory}</h1>
      <MemoryEditor />
      {memories.isPending ? (
        <Loading label={t.loading} />
      ) : memories.error && !memories.data ? (
        <LoadError error={memories.error} onRetry={() => void memories.refetch()} retryLabel={t.retry} />
      ) : memories.data.length === 0 ? (
        <Empty icon={<Brain />} text={t.noMemories} />
      ) : (
        <section aria-label={t.nav_memory} className="flex flex-col gap-2">
          <Card>
            <ul className="divide-y divide-line">
              {memories.data.map((m) => (
                <MemoryRow key={m.id} memory={m} />
              ))}
            </ul>
          </Card>
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
      className={memory ? "flex flex-col gap-2" : "rounded-(--radius-card) border border-line bg-surface shadow-sm focus-within:border-line-strong"}
    >
      <Field label={memory ? t.editMemory : t.addMemory} srOnlyLabel className="gap-0">
        <Textarea
          autoFocus={!!memory}
          value={text}
          maxLength={2000}
          rows={memory ? 2 : 2}
          onChange={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
            if (e.key === "Escape" && memory) onDone?.();
          }}
          placeholder={t.memoryPlaceholder}
          className={memory ? "min-h-16 text-sm" : "min-h-20 rounded-b-none border-0 bg-transparent px-4 pt-4 text-base focus-visible:outline-none"}
        />
      </Field>
      <div className={memory ? "flex justify-end gap-2" : "flex items-center justify-end gap-2 border-t border-line px-3 py-2"}>
        {memory && (
          <Button size="sm" variant="ghost" onClick={onDone}>
            <X aria-hidden />
            {t.cancel}
          </Button>
        )}
        <Button type="submit" size={memory ? "sm" : "md"} variant="primary" disabled={!canSave}>
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
  const agent = memory.source === "agent";
  const SourceIcon = agent ? Bot : UserRound;

  if (editing) {
    return (
      <li className="px-4 py-3">
        <MemoryEditor memory={memory} onDone={() => setEditing(false)} />
      </li>
    );
  }

  return (
    <li className="flex items-start gap-3 py-2 ps-4 pe-2">
      <Tooltip label={agent ? t.memoryByAgent : t.memoryByYou}>
        <SourceIcon role="img" aria-label={agent ? t.memoryByAgent : t.memoryByYou} className={agent ? "mt-2.5 size-4 shrink-0 text-accent-text" : "mt-2.5 size-4 shrink-0 text-fg-muted"} />
      </Tooltip>
      <div className="min-w-0 flex-1 py-1.5">
        <p className="text-sm leading-relaxed break-words whitespace-pre-wrap">{memory.text}</p>
        <time dateTime={memory.updatedAt} className="text-xs text-fg-muted">
          {relativeTime(memory.updatedAt)}
        </time>
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
