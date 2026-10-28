import { ArrowUp, CalendarClock, CalendarDays, Radar, Repeat, Terminal, Timer, Zap } from "lucide-react";
import { useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { useNavigate } from "react-router";
import { useCreateTask } from "../api/tasks.ts";
import { PromptInput, PromptInputFooter, PromptInputSubmit, PromptInputTextarea } from "./ai-elements/prompt-input.tsx";
import { useT } from "../i18n.ts";
import { isValidCron, toCron, watchCron, type Preset, type WatchEvery } from "../lib/cron.ts";
import { Field, Input } from "../ui/field.tsx";
import { Select } from "../ui/select.tsx";
import { notify, notifyError } from "../ui/toast.tsx";
import { Segmented } from "../ui/toggle-group.tsx";

/** "watch" is a standing check: it runs on a schedule and only speaks up when something new matches. */
type Mode = Preset | "watch";

/** The hero interaction: describe the work, pick when (or watch), hand it off. */
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
  const [mode, setMode] = useState<Mode>("once");
  const [every, setEvery] = useState<WatchEvery>("hourly");
  const [time, setTime] = useState("08:00");
  const [cron, setCron] = useState("");
  const formRef = useRef<HTMLFormElement>(null);
  const hintId = useId();
  const watch = mode === "watch";
  const needsCron = watch ? every === "custom" : mode === "custom";
  const needsTime = watch ? every === "daily" : mode === "daily" || mode === "weekdays";
  const cronError = needsCron && cron.trim() !== "" && !isValidCron(cron) ? t.cronInvalid : undefined;
  const canSubmit = text.trim().length > 0 && !cronError && !(needsCron && !cron.trim()) && !create.isPending;
  const modes: { value: Mode; label: string; icon: ReactNode }[] = [
    { value: "once", label: t.sched_once, icon: <Zap aria-hidden /> },
    { value: "daily", label: t.sched_daily, icon: <Repeat aria-hidden /> },
    { value: "weekdays", label: t.sched_weekdays, icon: <CalendarDays aria-hidden /> },
    { value: "custom", label: t.sched_custom, icon: <Terminal aria-hidden /> },
    { value: "watch", label: t.sched_watch, icon: <Radar aria-hidden /> },
  ];

  function submit() {
    if (!canSubmit) return;
    const schedule = watch ? watchCron(every, time, cron) : toCron(mode as Preset, time, cron);
    create.mutate(
      { instructions: text.trim(), ...(schedule ? { schedule } : {}), ...(watch ? { mode: "watch" as const } : {}) },
      {
        onSuccess: (task) => {
          setText("");
          notify("success", watch ? t.watchStarted : schedule ? t.taskScheduled : t.taskQueued, task.title, {
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
    <PromptInput
      ref={formRef}
      aria-label={t.delegate}
      onSubmit={() => submit()}
      className="rounded-(--radius-card)"
    >
      <PromptInputTextarea
        ref={inputRef}
        label={t.instructions}
        autoFocus={autoFocus}
        value={text}
        onChange={(e) => setText(e.currentTarget.value)}
        placeholder={watch ? t.watchPlaceholder : t.delegatePlaceholder}
        aria-describedby={hintId}
        className="min-h-28 pt-4 text-base"
      />
      <span id={hintId} className="sr-only">
        {t.newlineHint}
      </span>
      <PromptInputFooter className="flex-wrap border-t border-line px-3 py-2">
        {/* Five segments don't fit a phone (least of all in Vietnamese): a select there instead. */}
        <Segmented<Mode> label={t.schedule} value={mode} onChange={setMode} size="sm" className="max-sm:hidden" options={modes} />
        <Select<Mode> aria-label={t.schedule} value={mode} onChange={setMode} className="h-8 w-auto min-w-36 flex-1 text-sm sm:hidden" options={modes} />
        {watch && (
          <Select<WatchEvery>
            aria-label={t.watchEvery}
            value={every}
            onChange={setEvery}
            className="h-8 w-auto min-w-36 text-sm max-sm:flex-1"
            options={[
              { value: "hourly", label: t.every_hourly, icon: <Timer aria-hidden /> },
              { value: "4h", label: t.every_4h, icon: <Timer aria-hidden /> },
              { value: "daily", label: t.every_daily, icon: <Repeat aria-hidden /> },
              { value: "custom", label: t.sched_custom, icon: <Terminal aria-hidden /> },
            ]}
          />
        )}
        {needsTime && (
          <label className="flex items-center gap-1.5 text-sm text-fg-muted">
            <CalendarClock aria-hidden className="size-4" />
            <span className="sr-only">{t.timeOfDay}</span>
            <Input type="time" value={time} onValueChange={setTime} className="h-8 w-28 text-sm" />
          </label>
        )}
        {needsCron && (
          <Field label={t.cronExpr} srOnlyLabel error={cronError} className="min-w-40 flex-1">
            <Input value={cron} onValueChange={setCron} placeholder="0 8 * * 1" spellCheck={false} className="h-8 font-mono text-sm" />
          </Field>
        )}
        <PromptInputSubmit size="md" disabled={!canSubmit} className="ms-auto rounded-lg" title={t.newlineHint}>
          {watch ? t.startWatch : t.delegate}
          {watch ? <Radar aria-hidden /> : <ArrowUp aria-hidden />}
        </PromptInputSubmit>
      </PromptInputFooter>
    </PromptInput>
  );
}
