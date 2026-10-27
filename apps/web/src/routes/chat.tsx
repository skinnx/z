import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  getToolName,
  isToolUIPart,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  type DynamicToolUIPart,
  type ToolUIPart,
  type UIMessage,
} from "ai";
import {
  ArrowUp,
  Brain,
  Check,
  CircleAlert,
  Copy,
  Hand,
  KeyRound,
  ListCollapse,
  MessageSquarePlus,
  RefreshCw,
  ShieldCheck,
  Square,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, Navigate, NavLink, useLocation, useNavigate, useParams } from "react-router";
import { Streamdown } from "streamdown";
import { authHeaders, authRequired } from "../api/client.ts";
import { keys, queryClient } from "../api/query.ts";
import { useModelRefs, useProviders, useRouting } from "../api/providers.ts";
import { useDeleteThread, useThread, useThreads, type ThreadSummary } from "../api/threads.ts";
import { useT } from "../i18n.ts";
import { cn } from "../lib/cn.ts";
import { json, relativeTime } from "../lib/format.ts";
import { Confirm } from "../ui/alert-dialog.tsx";
import { Button, buttonClass } from "../ui/button.tsx";
import { Empty, Spinner } from "../ui/card.tsx";
import { Disclosure } from "../ui/collapsible.tsx";
import { Combobox } from "../ui/combobox.tsx";
import { Drawer } from "../ui/drawer.tsx";
import { IconButton } from "../ui/icon-button.tsx";
import { ScrollArea } from "../ui/scroll-area.tsx";
import { notifyError } from "../ui/toast.tsx";

const newId = () => crypto.randomUUID();

export default function ChatRoute() {
  const { id } = useParams();
  const location = useLocation();
  if (!id) return <Navigate to={`/chat/${newId()}`} replace state={{ fresh: true }} />;
  const fresh = (location.state as { fresh?: boolean } | null)?.fresh === true;
  return <ChatScreen id={id} fresh={fresh} />;
}

function ChatScreen({ id, fresh }: { id: string; fresh: boolean }) {
  const t = useT();
  const thread = useThread(id, !fresh);
  const [threadsOpen, setThreadsOpen] = useState(false);

  return (
    <div className="flex h-[calc(100dvh-4rem-env(safe-area-inset-bottom))] md:h-dvh">
      <h1 className="sr-only">{t.nav_chat}</h1>
      <aside aria-label={t.threads} className="hidden w-64 shrink-0 flex-col border-e border-line lg:flex">
        <ThreadList current={id} />
      </aside>
      <Drawer open={threadsOpen} onOpenChange={setThreadsOpen} side="left" title={t.threads}>
        <ThreadList current={id} onPick={() => setThreadsOpen(false)} />
      </Drawer>
      <div className="flex min-w-0 flex-1 flex-col">
        {thread.data ? (
          <Conversation key={id} id={id} initial={thread.data.messages} onOpenThreads={() => setThreadsOpen(true)} />
        ) : thread.error ? (
          <div className="grid flex-1 place-items-center p-6">
            <Empty icon={<CircleAlert />} text={thread.error.message}>
              <Button onClick={() => thread.refetch()}>{t.retry}</Button>
            </Empty>
          </div>
        ) : (
          <div role="status" className="grid flex-1 place-items-center text-fg-muted">
            <Spinner />
            <span className="sr-only">{t.loading}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function ThreadList({ current, onPick }: { current: string; onPick?: () => void }) {
  const t = useT();
  const threads = useThreads();
  const remove = useDeleteThread();
  const navigate = useNavigate();
  const list = threads.data ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="p-3">
        <Link to="/chat" onClick={onPick} className={buttonClass("secondary", "md", "w-full justify-start")}>
          <MessageSquarePlus aria-hidden />
          {t.newChat}
        </Link>
      </div>
      <ScrollArea className="flex-1" label={t.threads}>
        <ul className="flex flex-col gap-0.5 px-2 pb-3">
          {list.map((th: ThreadSummary) => (
            <li key={th.id} className="group relative">
              <NavLink
                to={`/chat/${encodeURIComponent(th.id)}`}
                onClick={onPick}
                className={({ isActive }) =>
                  cn(
                    "flex min-h-11 flex-col justify-center rounded-lg px-3 py-1.5 pe-10 text-sm",
                    isActive || th.id === current ? "bg-subtle text-fg" : "text-fg-muted hover:bg-subtle/60 hover:text-fg",
                  )
                }
              >
                <span className="truncate font-medium">{th.title || "…"}</span>
                <time dateTime={th.updatedAt} className="text-xs text-fg-muted">
                  {relativeTime(th.updatedAt)}
                </time>
              </NavLink>
              <div className="absolute end-1 top-1/2 -translate-y-1/2 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100">
                <Confirm
                  trigger={
                    <Button variant="ghost" size="icon-sm" aria-label={`${t.deleteChat}: ${th.title}`}>
                      <Trash2 aria-hidden />
                    </Button>
                  }
                  title={t.deleteChat}
                  confirmLabel={t.delete}
                  onConfirm={() =>
                    remove.mutateAsync(th.id).then(() => {
                      if (th.id === current) navigate("/chat", { replace: true });
                    }, notifyError)
                  }
                />
              </div>
            </li>
          ))}
        </ul>
      </ScrollArea>
    </div>
  );
}

function Conversation({ id, initial, onOpenThreads }: { id: string; initial: UIMessage[]; onOpenThreads: () => void }) {
  const t = useT();
  const refs = useModelRefs();
  const providers = useProviders();
  const routing = useRouting();
  const [model, setModel] = useState<string | null>(null);
  const modelRef = useRef<string | null>(null);
  modelRef.current = model;
  const defaultRef = routing.data?.chat?.[0] ?? null;

  const transport = useMemo(
    () =>
      new DefaultChatTransport<UIMessage>({
        api: "/api/chat",
        headers: () => authHeaders(),
        body: () => (modelRef.current ? { model: modelRef.current } : {}),
        fetch: async (input, init) => {
          const res = await fetch(input, init);
          if (res.status === 401) authRequired.set(true);
          return res;
        },
      }),
    [],
  );

  const { messages, sendMessage, status, stop, regenerate, addToolApprovalResponse, error, clearError } = useChat({
    id,
    messages: initial,
    transport,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    onFinish: () => void queryClient.invalidateQueries({ queryKey: keys.threads }),
  });

  const busy = status === "submitted" || status === "streaming";
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const noProviders = providers.data?.length === 0;

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }, [messages, status]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const send = () => {
    const value = text.trim();
    if (!value || busy) return;
    setText("");
    if (initial.length === 0 && messages.length === 0) {
      // A brand new thread becomes visible in the list as soon as the server has it.
      setTimeout(() => void queryClient.invalidateQueries({ queryKey: keys.threads }), 1500);
    }
    void sendMessage({ text: value });
  };

  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");

  return (
    <>
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <IconButton label={t.openThreads} className="lg:hidden" onClick={onOpenThreads}>
          <ListCollapse aria-hidden />
        </IconButton>
        <div className="min-w-0 flex-1 sm:max-w-sm">
          <Combobox
            aria-label={t.model}
            items={refs}
            value={model}
            onChange={setModel}
            mono
            placeholder={defaultRef ? `${defaultRef}` : t.defaultModel}
            emptyText={t.noModels}
            className="h-9"
          />
        </div>
        <Link to="/chat" aria-label={t.newChat} title={t.newChat} className={buttonClass("ghost", "icon", "ms-auto")}>
          <MessageSquarePlus aria-hidden />
        </Link>
      </div>

      <ScrollArea className="flex-1" viewportClassName="px-4">
        <div role="log" aria-live="polite" aria-busy={busy} aria-label={t.nav_chat} className="mx-auto flex max-w-3xl flex-col gap-6 py-6">
          {messages.length === 0 &&
            (noProviders ? (
              <Empty icon={<KeyRound />} text={t.noModels} className="mt-10">
                <Link to="/models" className={buttonClass("primary")}>
                  {t.addProvider}
                </Link>
              </Empty>
            ) : (
              <p className="mt-16 text-center text-sm text-fg-muted">{t.chatEmpty}</p>
            ))}
          {messages.map((m) => (
            <Message
              key={m.id}
              message={m}
              streaming={busy && m === messages[messages.length - 1]}
              onApprove={(approvalId, approved) => void addToolApprovalResponse({ id: approvalId, approved })}
              actions={
                m === lastAssistant && !busy && !m.parts.some((p) => isToolUIPart(p) && p.state === "approval-requested") ? (
                  <MessageActions message={m} onRegenerate={() => void regenerate()} />
                ) : null
              }
            />
          ))}
          {status === "submitted" && (
            <p role="status" className="flex items-center gap-2 text-sm text-fg-muted">
              <Spinner />
              {t.thinking}
            </p>
          )}
          {error && (
            <div role="alert" className="flex items-start gap-3 rounded-xl border border-danger/40 bg-danger-soft p-3 text-sm text-danger">
              <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
              <p className="min-w-0 flex-1 break-words">{error.message}</p>
              <Button
                size="sm"
                onClick={() => {
                  clearError();
                  void regenerate();
                }}
              >
                <RefreshCw aria-hidden />
                {t.retry}
              </Button>
            </div>
          )}
          <div ref={endRef} />
        </div>
      </ScrollArea>

      <form
        className="border-t border-line bg-bg px-3 py-3"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <div className="mx-auto flex max-w-3xl items-end gap-2 rounded-2xl border border-line bg-surface p-1.5 ps-4 focus-within:border-line-strong">
          <label htmlFor="chat-input" className="sr-only">
            {t.messagePlaceholder}
          </label>
          <textarea
            id="chat-input"
            ref={inputRef}
            rows={1}
            value={text}
            onChange={(e) => setText(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
            placeholder={t.messagePlaceholder}
            className="max-h-48 min-h-10 flex-1 resize-none bg-transparent py-2 text-[0.9375rem] leading-6 outline-none [field-sizing:content] placeholder:text-fg-muted"
          />
          {busy ? (
            <Button variant="secondary" size="icon" aria-label={t.stop} onClick={() => void stop()} className="rounded-xl">
              <Square aria-hidden className="fill-current" />
            </Button>
          ) : (
            <Button type="submit" variant="primary" size="icon" aria-label={t.send} disabled={!text.trim()} className="rounded-xl">
              <ArrowUp aria-hidden />
            </Button>
          )}
        </div>
      </form>
    </>
  );
}

function MessageActions({ message, onRegenerate }: { message: UIMessage; onRegenerate: () => void }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const text = message.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
  return (
    <div className="-ms-2 flex gap-0.5">
      <IconButton
        label={copied ? t.copied : t.copy}
        size="icon-sm"
        className="text-fg-muted"
        onClick={() =>
          void navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
        }
      >
        {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
      </IconButton>
      <IconButton label={t.regenerate} size="icon-sm" className="text-fg-muted" onClick={onRegenerate}>
        <RefreshCw aria-hidden />
      </IconButton>
    </div>
  );
}

function Message({
  message,
  streaming,
  onApprove,
  actions,
}: {
  message: UIMessage;
  streaming: boolean;
  onApprove: (approvalId: string, approved: boolean) => void;
  actions: React.ReactNode;
}) {
  const t = useT();
  if (message.role === "user") {
    const text = message.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
    return (
      <div className="flex justify-end">
        <p className="max-w-[85%] rounded-2xl rounded-ee-md bg-accent-soft px-4 py-2.5 text-[0.9375rem] leading-relaxed whitespace-pre-wrap break-words">
          <span className="sr-only">{t.you}: </span>
          {text}
        </p>
      </div>
    );
  }
  if (message.role !== "assistant") return null;
  return (
    <article className="flex flex-col gap-2" aria-label={t.assistant}>
      {message.parts.map((part, i) => {
        if (part.type === "text") {
          return (
            <div key={i} className="prose-z min-w-0 break-words">
              <Streamdown isAnimating={streaming} mode={streaming ? "streaming" : "static"}>
                {part.text}
              </Streamdown>
            </div>
          );
        }
        if (part.type === "reasoning" && part.text) {
          return (
            <Disclosure key={i} summary={<span className="flex items-center gap-1"><Brain aria-hidden className="size-3.5" />{t.thinking.replace("…", "")}</span>}>
              <p className="mt-1 border-s-2 border-line ps-3 text-sm whitespace-pre-wrap text-fg-muted">{part.text}</p>
            </Disclosure>
          );
        }
        if (part.type === "source-url") {
          return (
            <a key={i} href={part.url} target="_blank" rel="noreferrer" className="truncate text-xs text-accent-text underline">
              {part.title ?? part.url}
            </a>
          );
        }
        if (isToolUIPart(part)) return <ToolCall key={i} part={part} onApprove={onApprove} />;
        return null;
      })}
      {actions}
    </article>
  );
}

function ToolCall({ part, onApprove }: { part: ToolUIPart | DynamicToolUIPart; onApprove: (id: string, approved: boolean) => void }) {
  const t = useT();
  const name = getToolName(part);
  const state = part.state;
  const status =
    state === "output-available"
      ? { icon: <Check aria-hidden className="size-3.5 text-ok" />, label: t.toolDone }
      : state === "output-error"
        ? { icon: <X aria-hidden className="size-3.5 text-danger" />, label: t.toolError }
        : state === "output-denied"
          ? { icon: <X aria-hidden className="size-3.5 text-fg-muted" />, label: t.toolDenied }
          : state === "approval-requested"
            ? { icon: <Hand aria-hidden className="size-3.5 text-warn" />, label: t.toolAwaiting }
            : { icon: <Spinner className="size-3" />, label: t.toolRunning };

  return (
    <div className={cn("rounded-xl border bg-surface", state === "approval-requested" ? "border-warn/60" : "border-line")}>
      <div className="flex items-center gap-2 px-3 py-2 text-sm">
        <Wrench aria-hidden className="size-4 text-fg-muted" />
        <code className="min-w-0 flex-1 truncate font-mono text-xs">{name}</code>
        <span className="flex items-center gap-1 text-xs text-fg-muted">
          {status.icon}
          {status.label}
        </span>
      </div>
      <div className="border-t border-line px-3 pb-2">
        <Disclosure summary={t.showDetails}>
          <pre className="max-h-56 overflow-auto rounded-lg bg-subtle p-2 font-mono text-xs leading-relaxed">
            {json(part.state === "output-available" ? { input: part.input, output: part.output } : part.state === "output-error" ? { input: part.input, error: part.errorText } : { input: part.input })}
          </pre>
        </Disclosure>
        {state === "approval-requested" && part.approval && (
          <div className="mt-1 flex flex-wrap gap-2">
            <Button size="sm" variant="primary" onClick={() => onApprove(part.approval!.id, true)}>
              <ShieldCheck aria-hidden />
              {t.approve}
            </Button>
            <Button size="sm" variant="danger" onClick={() => onApprove(part.approval!.id, false)}>
              <X aria-hidden />
              {t.deny}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
