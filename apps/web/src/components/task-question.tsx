import type { Task } from "@z/core";
import { MessageCircleQuestion, Send } from "lucide-react";
import { useState } from "react";
import { useAnswerTask } from "../api/tasks.ts";
import { useT } from "../i18n.ts";
import { relativeTime } from "../lib/format.ts";
import { Button } from "../ui/button.tsx";
import { Field, Input } from "../ui/field.tsx";
import { notifyError } from "../ui/toast.tsx";

/** The agent's `ask_person` question with one-tap choices and a free-text answer. */
export function TaskQuestion({ task }: { task: Task }) {
  const t = useT();
  const answer = useAnswerTask();
  const [text, setText] = useState("");
  const q = task.question;
  if (task.status !== "needs_input" || !q) return null;
  const send = (value: string) => value.trim() && answer.mutate({ id: task.id, text: value.trim() }, { onError: notifyError });

  return (
    <section aria-label={t.status_needs_input} className="flex flex-col gap-3 rounded-xl border border-warn/40 bg-warn-soft/40 p-3">
      <p className="flex items-start gap-2 font-medium leading-snug break-words">
        <MessageCircleQuestion aria-hidden className="mt-0.5 size-4 shrink-0 text-warn" />
        <span className="min-w-0 flex-1">{q.question}</span>
        <time dateTime={q.askedAt} className="shrink-0 text-xs font-normal text-fg-muted">
          {relativeTime(q.askedAt)}
        </time>
      </p>
      {q.choices.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {q.choices.map((choice) => (
            <Button key={choice} size="sm" disabled={answer.isPending} onClick={() => send(choice)}>
              {choice}
            </Button>
          ))}
        </div>
      )}
      <form
        className="flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          send(text);
        }}
      >
        <Field label={t.answerLabel} srOnlyLabel className="min-w-0 flex-1">
          <Input value={text} onChange={(e) => setText(e.target.value)} placeholder={t.answerPlaceholder} maxLength={4000} />
        </Field>
        <Button type="submit" variant="primary" disabled={answer.isPending || !text.trim()}>
          <Send aria-hidden />
          {t.sendAnswer}
        </Button>
      </form>
    </section>
  );
}
