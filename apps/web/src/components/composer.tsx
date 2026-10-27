import { Form } from "@base-ui/react/form";
import { ArrowUp, CalendarClock, CalendarDays, Repeat, Terminal, Zap } from "lucide-react";
import { useRef, useState, type RefObject } from "react";
import { useNavigate } from "react-router";
import { useCreateTask } from "../api/tasks.ts";
import { useT } from "../i18n.ts";
import { isValidCron, toCron, type Preset } from "../lib/cron.ts";
import { Button } from "../ui/button.tsx";
import { Field, Input, Textarea } from "../ui/field.tsx";
import { notify, notifyError } from "../ui/toast.tsx";
import { Segmented } from "../ui/toggle-group.tsx";

/** The hero interaction: describe the work, pick when, hand it off. */
export function Composer({
  inputRef,
  initial = "",
  onDone,
  autoFocus,
}: {
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  initial?: string;
  onDone?: () => void;
  autoFocus?: boolean;
}) {
  const t = useT();
  const navigate = useNavigate();
  const create = useCreateTask();
  const [text, setText] = useState(initial);
  const [preset, setPreset] = useState<Preset>("once");
  const [time, setTime] = useState("08:00");
  const [cron, setCron] = useState("");
  const formRef = useRef<HTMLFormElement>(null);
  const cronError = preset === "custom" && cron.trim() !== "" && !isValidCron(cron) ? t.cronInvalid : undefined;
  const canSubmit = text.trim().length > 0 && !cronError && !(preset === "custom" && !cron.trim()) && !create.isPending;

  function submit() {
    if (!canSubmit) return;
    const schedule = toCron(preset, time, cron);
    create.mutate(
      { instructions: text.trim(), ...(schedule ? { schedule } : {}) },
      {
        onSuccess: (task) => {
          setText("");
          notify("success", schedule ? t.taskScheduled : t.taskQueued, task.title, {
            label: t.showDetails,
            onClick: () => navigate(`/tasks?task=${encodeURIComponent(task.id)}`),
          });
          onDone?.();
        },
        onError: notifyError,
      },
    );
  }

  return (
    <Form
      ref={formRef}
      aria-label={t.delegate}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="rounded-(--radius-card) border border-line bg-surface shadow-sm transition-colors focus-within:border-line-strong"
    >
      <Field label={t.instructions} srOnlyLabel className="gap-0">
        <Textarea
          ref={inputRef}
          autoFocus={autoFocus}
          value={text}
          onChange={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={t.delegatePlaceholder}
          rows={3}
          className="min-h-28 rounded-b-none border-0 bg-transparent px-4 pt-4 text-base focus-visible:outline-none"
        />
      </Field>
      <div className="flex flex-wrap items-center gap-2 border-t border-line px-3 py-2">
        <Segmented<Preset>
          label={t.schedule}
          value={preset}
          onChange={setPreset}
          size="sm"
          options={[
            { value: "once", label: t.sched_once, icon: <Zap aria-hidden /> },
            { value: "daily", label: t.sched_daily, icon: <Repeat aria-hidden /> },
            { value: "weekdays", label: t.sched_weekdays, icon: <CalendarDays aria-hidden /> },
            { value: "custom", label: t.sched_custom, icon: <Terminal aria-hidden /> },
          ]}
        />
        {(preset === "daily" || preset === "weekdays") && (
          <label className="flex items-center gap-1.5 text-sm text-fg-muted">
            <CalendarClock aria-hidden className="size-4" />
            <span className="sr-only">{t.timeOfDay}</span>
            <Input type="time" value={time} onValueChange={setTime} className="h-8 w-28 text-sm" />
          </label>
        )}
        {preset === "custom" && (
          <Field label={t.cronExpr} srOnlyLabel error={cronError} className="min-w-40 flex-1">
            <Input value={cron} onValueChange={setCron} placeholder="0 8 * * 1" spellCheck={false} className="h-8 font-mono text-sm" />
          </Field>
        )}
        <Button type="submit" variant="primary" disabled={!canSubmit} className="ms-auto" title={t.shortcutSubmit}>
          {t.delegate}
          <ArrowUp aria-hidden />
        </Button>
      </div>
    </Form>
  );
}
