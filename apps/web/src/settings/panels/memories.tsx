/** What z knows about its owner: review, search, add, pin, correct or forget. Never shown to channel bots. */
import type { Memory } from "@z/core";
import { Form } from "@base-ui/react/form";
import { Bot, Brain, Check, Pencil, Pin, Plus, Search, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useConfirmMemory, useDeleteMemory, useMemories, useMemorySearch, usePinMemory, useSaveMemory } from "../../api/memories.ts";
import { useT } from "../../i18n.ts";
import { cn } from "../../lib/cn.ts";
import { relativeTime } from "../../lib/format.ts";
import { Confirm } from "../../ui/alert-dialog.tsx";
import { Button } from "../../ui/button.tsx";
import { Badge, Empty, Loading, LoadError, Spinner } from "../../ui/card.tsx";
import { Field, Input, Textarea } from "../../ui/field.tsx";
import { IconButton } from "../../ui/icon-button.tsx";
import { notifyError } from "../../ui/toast.tsx";

const SEARCH_FROM = 6;
const SEARCH_DELAY_MS = 200;

/** Pinned first, then newest. */
const byPinned = (a: Memory, b: Memory) => Number(b.pinned) - Number(a.pinned);

export function MemoryManager() {
  const t = useT();
  const memories = useMemories();
  const [query, setQuery] = useState("");
  const q = useDebounced(query.trim(), SEARCH_DELAY_MS);
  const search = useMemorySearch(q);
  const list = memories.data ?? [];
  const waiting = list.filter((m) => m.status === "unreviewed");
  const active = list.filter((m) => m.status === "active").sort(byPinned);
  const shown = q ? (search.data ?? []).filter((m) => m.status === "active") : active;

  return (
    <div className="flex flex-col gap-4">
      {waiting.length > 0 && (
        <section aria-labelledby="memories-review" className="flex flex-col gap-2">
          <div className="px-1">
            <h3 id="memories-review" className="text-sm font-semibold">
              {t.awaitingReview} ({waiting.length})
            </h3>
            <p className="text-xs text-fg-muted">{t.awaitingReviewHint}</p>
          </div>
          <ul aria-live="polite" className="divide-y divide-line rounded-(--radius-card) border border-accent/40 bg-accent-soft/30">
            {waiting.map((m) => (
              <ReviewRow key={m.id} memory={m} />
            ))}
          </ul>
        </section>
      )}
      <MemoryEditor />
      {memories.isPending ? (
        <Loading label={t.loading} />
      ) : memories.error && !memories.data ? (
        <LoadError error={memories.error} onRetry={() => void memories.refetch()} retryLabel={t.retry} />
      ) : active.length === 0 ? (
        waiting.length === 0 && <Empty icon={<Brain />} text={t.noMemories} />
      ) : (
        <section aria-label={t.memories} className="flex flex-col gap-2">
          {active.length > SEARCH_FROM && (
            <div className="relative">
              <Search aria-hidden className="pointer-events-none absolute start-3 top-3 size-4 text-fg-muted" />
              <Input type="search" aria-label={t.searchMemories} placeholder={t.searchMemories} value={query} onValueChange={setQuery} className="ps-9" />
              {q && search.isFetching && <Spinner className="absolute end-3 top-3 text-fg-muted" />}
            </div>
          )}
          {q && search.error ? (
            <LoadError error={search.error} onRetry={() => void search.refetch()} retryLabel={t.retry} />
          ) : q && !search.data ? (
            <Loading label={t.loading} />
          ) : shown.length === 0 ? (
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

function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/** Add (or edit, when `memory` is given) one memory. Saving an unreviewed memory also confirms it. */
function MemoryEditor({ memory, onDone }: { memory?: Memory; onDone?: () => void }) {
  const t = useT();
  const save = useSaveMemory();
  const [text, setText] = useState(memory?.text ?? "");
  const reviewing = memory?.status === "unreviewed";
  const canSave = text.trim().length > 0 && (reviewing || text.trim() !== memory?.text) && !save.isPending;

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
      className={memory ? "flex flex-col gap-2" : "rounded-(--radius-card) border border-line bg-surface has-[textarea:focus-visible]:border-accent has-[textarea:focus-visible]:outline-2 has-[textarea:focus-visible]:-outline-offset-1 has-[textarea:focus-visible]:outline-accent"}
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
          {reviewing ? t.saveAndConfirm : memory ? t.save : t.remember}
        </Button>
      </div>
    </Form>
  );
}

function MemoryMeta({ memory }: { memory: Memory }) {
  const t = useT();
  return (
    <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-fg-muted">
      {memory.pinned && (
        <Badge tone="accent" className="h-5">
          <Pin aria-hidden />
          {t.pinnedMemory}
        </Badge>
      )}
      {memory.source === "agent" ? (
        <Badge tone={memory.status === "unreviewed" ? "neutral" : "accent"} className="h-5">
          <Bot aria-hidden />
          {t.memoryByAgent}
        </Badge>
      ) : (
        <span className="sr-only">{t.memoryByYou}</span>
      )}
      <time dateTime={memory.updatedAt}>{relativeTime(memory.updatedAt)}</time>
    </p>
  );
}

/** A memory z saved on its own: confirm, correct or discard it. */
function ReviewRow({ memory }: { memory: Memory }) {
  const t = useT();
  const confirm = useConfirmMemory();
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
    <li className="flex flex-col gap-2 py-2 ps-4 pe-2 sm:flex-row sm:items-start">
      <div className="min-w-0 flex-1 py-1.5">
        <p className="text-sm leading-relaxed break-words whitespace-pre-wrap">{memory.text}</p>
        <MemoryMeta memory={memory} />
      </div>
      <div className="flex items-center justify-end gap-1 sm:pt-1">
        <IconButton label={t.discardMemory} size="icon-sm" className="hover:text-danger" disabled={remove.isPending} onClick={() => remove.mutate(memory.id, { onError: notifyError })}>
          <X aria-hidden />
        </IconButton>
        <IconButton label={t.edit} size="icon-sm" onClick={() => setEditing(true)}>
          <Pencil aria-hidden />
        </IconButton>
        <Button size="sm" variant="primary" disabled={confirm.isPending} onClick={() => confirm.mutate(memory.id, { onError: notifyError })}>
          {confirm.isPending ? <Spinner /> : <Check aria-hidden />}
          {t.confirmMemory}
        </Button>
      </div>
    </li>
  );
}

function MemoryRow({ memory }: { memory: Memory }) {
  const t = useT();
  const remove = useDeleteMemory();
  const pin = usePinMemory();
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
        <MemoryMeta memory={memory} />
      </div>
      <IconButton
        label={t.pinMemory}
        aria-pressed={memory.pinned}
        size="icon-sm"
        className={cn(memory.pinned && "text-accent-text")}
        disabled={pin.isPending}
        onClick={() => pin.mutate({ id: memory.id, pinned: !memory.pinned }, { onError: notifyError })}
      >
        <Pin aria-hidden className={cn(memory.pinned && "fill-current")} />
      </IconButton>
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
