import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  getToolName,
  isToolUIPart,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  type ChatStatus,
  type DynamicToolUIPart,
  type SourceUrlUIPart,
  type ToolUIPart,
  type UIMessage,
} from "ai";
import { Check, ChevronsUpDown, CircleAlert, Copy, Cpu, KeyRound, ListCollapse, MessageSquarePlus, RefreshCw, ShieldCheck, Sparkles, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, Navigate, NavLink, useLocation, useNavigate, useParams } from "react-router";
import { authHeaders, authRequired } from "../api/client.ts";
import { useConnectors } from "../api/connectors.ts";
import { usePlugins } from "../api/plugins.ts";
import { keys, queryClient } from "../api/query.ts";
import { useProviders, useRouting } from "../api/providers.ts";
import { useDeleteThread, useThread, useThreads, type ThreadSummary } from "../api/threads.ts";
import { Confirmation, ConfirmationAccepted, ConfirmationAction, ConfirmationActions, ConfirmationRejected, ConfirmationRequest, ConfirmationTitle } from "../components/ai-elements/confirmation.tsx";
import { Conversation, ConversationContent, ConversationEmptyState, ConversationScrollButton } from "../components/ai-elements/conversation.tsx";
import {
  InlineCitation,
  InlineCitationCard,
  InlineCitationCarousel,
  InlineCitationCarouselHeader,
  InlineCitationCarouselIndex,
  InlineCitationCarouselItem,
  InlineCitationCarouselNext,
  InlineCitationCarouselPrev,
  InlineCitationSource,
} from "../components/ai-elements/inline-citation.tsx";
import { Loader } from "../components/ai-elements/loader.tsx";
import { Message, MessageAction, MessageActions, MessageContent, MessageResponse } from "../components/ai-elements/message.tsx";
import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  type ModelSelectorGroupData,
} from "../components/ai-elements/model-selector.tsx";
import { PromptInput, PromptInputButton, PromptInputFooter, PromptInputSubmit, PromptInputTextarea, PromptInputTools } from "../components/ai-elements/prompt-input.tsx";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "../components/ai-elements/reasoning.tsx";
import { Shimmer } from "../components/ai-elements/shimmer.tsx";
import { Source, Sources, SourcesContent, SourcesTrigger } from "../components/ai-elements/sources.tsx";
import { Suggestion, Suggestions } from "../components/ai-elements/suggestion.tsx";
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from "../components/ai-elements/tool.tsx";
import { useT } from "../i18n.ts";
import { cn } from "../lib/cn.ts";
import { relativeTime } from "../lib/format.ts";
import { splitRef } from "../lib/models.ts";
import { Confirm } from "../ui/alert-dialog.tsx";
import { Button, buttonClass } from "../ui/button.tsx";
import { Empty, Spinner } from "../ui/card.tsx";
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
          <ChatView key={id} id={id} initial={thread.data.messages} onOpenThreads={() => setThreadsOpen(true)} />
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

const textOf = (m: UIMessage) => m.parts.map((p) => (p.type === "text" ? p.text : "")).join("");

function ChatView({ id, initial, onOpenThreads }: { id: string; initial: UIMessage[]; onOpenThreads: () => void }) {
  const t = useT();
  const providers = useProviders();
  const [model, setModel] = useState<string | null>(null);
  const modelRef = useRef<string | null>(null);
  modelRef.current = model;

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
  const [stopped, setStopped] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const noProviders = providers.data?.length === 0;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const send = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || busy) return;
    setText("");
    setStopped(false);
    if (initial.length === 0 && messages.length === 0) {
      // A brand new thread becomes visible in the list as soon as the server has it.
      setTimeout(() => void queryClient.invalidateQueries({ queryKey: keys.threads }), 1500);
    }
    void sendMessage({ text: trimmed });
  };

  const prefill = (value: string) => {
    setText(value);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(value.length, value.length);
    });
  };

  const last = messages[messages.length - 1];
  const lastAssistant = messages.findLast((m) => m.role === "assistant");
  // Show the waiting indicator until the reply has something to show.
  const waiting = status === "submitted" || (status === "streaming" && (last?.role !== "assistant" || !last.parts.some(visiblePart)));

  return (
    <>
      <div className="flex items-center gap-2 border-b border-line px-3 py-2 lg:hidden">
        <IconButton label={t.openThreads} onClick={onOpenThreads}>
          <ListCollapse aria-hidden />
        </IconButton>
        <Link to="/chat" aria-label={t.newChat} title={t.newChat} className={buttonClass("ghost", "icon", "ms-auto")}>
          <MessageSquarePlus aria-hidden />
        </Link>
      </div>

      <Conversation role="log" aria-live="off" aria-label={t.nav_chat} aria-busy={busy}>
        <ConversationContent>
          {messages.length === 0 &&
            (noProviders ? (
              <Empty icon={<KeyRound />} text={t.noModels} className="mt-10">
                <Link to="/models" className={buttonClass("primary")}>
                  {t.addProvider}
                </Link>
              </Empty>
            ) : (
              <ChatEmptyState onPrefill={prefill} />
            ))}
          {messages.map((m) => (
            <ChatMessage
              key={m.id}
              message={m}
              streaming={busy && m === last}
              onApprove={(approvalId, approved) => void addToolApprovalResponse({ id: approvalId, approved })}
              actions={
                m === lastAssistant && !busy && !m.parts.some((p) => isToolUIPart(p) && p.state === "approval-requested") ? (
                  <ReplyActions
                    text={textOf(m)}
                    onRegenerate={() => {
                      setStopped(false);
                      void regenerate();
                    }}
                  />
                ) : null
              }
            />
          ))}
          {waiting && (
            <div className="flex items-center gap-2 text-sm">
              <Loader />
              <Shimmer as="span">{t.thinking}</Shimmer>
            </div>
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
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      <ChatAnnouncer messages={messages} status={status} stopped={stopped} />

      <div className="bg-bg px-3 pt-2 pb-3">
        <PromptInput className="mx-auto max-w-3xl" onSubmit={({ text: value }) => send(value)}>
          <PromptInputTextarea
            ref={inputRef}
            label={t.messagePlaceholder}
            placeholder={t.messagePlaceholder}
            value={text}
            onChange={(e) => setText(e.currentTarget.value)}
            aria-describedby="chat-newline-hint"
          />
          <span id="chat-newline-hint" className="sr-only">
            {t.newlineHint}
          </span>
          <PromptInputFooter>
            <PromptInputTools>
              <ModelPicker value={model} onChange={setModel} />
            </PromptInputTools>
            <PromptInputSubmit
              status={status}
              onStop={() => {
                setStopped(true);
                void stop();
              }} disabled={!text.trim()} />
          </PromptInputFooter>
        </PromptInput>
      </div>
    </>
  );
}

/** Parts that render something the reader can see. */
const visiblePart = (p: UIMessage["parts"][number]) =>
  (p.type === "text" && p.text.length > 0) || (p.type === "reasoning" && p.text.length > 0) || isToolUIPart(p) || p.type === "source-url";

/** Ways to start, grounded in what this z can actually do right now. */
function ChatEmptyState({ onPrefill }: { onPrefill: (text: string) => void }) {
  const t = useT();
  const navigate = useNavigate();
  const plugins = usePlugins();
  const connectors = useConnectors();
  const web = plugins.data?.find((p) => p.id === "web" && p.enabled);
  const sources = (connectors.data ?? []).filter((c) => c.enabled && c.status === "connected").slice(0, 2);

  return (
    <ConversationEmptyState icon={<Sparkles />} description={t.chatEmpty} className="mt-6">
      <Suggestions label={t.suggestions}>
        <Suggestion suggestion={t.sugDelegate} onClick={() => navigate("/?compose")} />
        {web && <Suggestion suggestion={t.sugFactCheck} onClick={() => onPrefill(t.sugFactCheckPrompt)} />}
        {sources.map((c) => (
          <Suggestion key={c.id} suggestion={t.sugAsk(c.label)} onClick={() => onPrefill(t.sugAskPrompt(c.label))} />
        ))}
        {web && <Suggestion suggestion={t.sugNews} onClick={() => onPrefill(t.sugNewsPrompt)} />}
      </Suggestions>
    </ConversationEmptyState>
  );
}

/** Markdown as it reads aloud: code blocks named, not spelled out; markup dropped. */
const speakable = (md: string) =>
  md
    .replace(/```[\s\S]*?(```|$)/g, " [code] ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/-{3,}|[*_`#>|~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();

/**
 * The visible log is not a live region (it would read every token). This one says, politely,
 * when z starts replying, when it needs an approval, and what it said once it is done.
 */
function ChatAnnouncer({ messages, status, stopped }: { messages: UIMessage[]; status: ChatStatus; stopped: boolean }) {
  const t = useT();
  const [say, setSay] = useState("");
  const prev = useRef(status);
  const last = messages.findLast((m) => m.role === "assistant");
  const asking = last?.parts.find((p): p is ToolUIPart | DynamicToolUIPart => isToolUIPart(p) && p.state === "approval-requested");
  const askingName = asking ? getToolName(asking) : null;

  useEffect(() => {
    const was = prev.current;
    prev.current = status;
    if (status === "submitted" && was !== "submitted") setSay(t.replying);
    else if (status === "ready" && (was === "streaming" || was === "submitted") && stopped) setSay(t.replyStopped);
    else if (status === "ready" && (was === "streaming" || was === "submitted") && last) {
      const reply = speakable(textOf(last));
      if (reply) setSay(t.replied(reply.length > 400 ? `${reply.slice(0, 400)}…` : reply));
    }
  }, [status, last, stopped, t]);

  useEffect(() => {
    if (askingName) setSay(t.toolAsk(askingName));
  }, [askingName, t]);

  return (
    <div role="status" aria-live="polite" className="sr-only">
      {say}
    </div>
  );
}

function ReplyActions({ text, onRegenerate }: { text: string; onRegenerate: () => void }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <MessageActions>
      <MessageAction
        tooltip={copied ? t.copied : t.copy}
        onClick={() =>
          void navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
        }
      >
        {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
      </MessageAction>
      <MessageAction tooltip={t.regenerate} onClick={onRegenerate}>
        <RefreshCw aria-hidden />
      </MessageAction>
    </MessageActions>
  );
}

function ChatMessage({
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
    return (
      <Message from="user">
        <MessageContent>
          <span className="sr-only">{t.you}: </span>
          {textOf(message)}
        </MessageContent>
      </Message>
    );
  }
  if (message.role !== "assistant") return null;

  const sources = message.parts.filter((p): p is SourceUrlUIPart => p.type === "source-url");
  const lastText = message.parts.findLastIndex((p) => p.type === "text");
  const lastIndex = message.parts.length - 1;

  return (
    <Message from="assistant" aria-label={t.assistant}>
      <MessageContent>
        {message.parts.map((part, i) => {
          if (part.type === "text") {
            if (!part.text) return null;
            return (
              <div key={i} className="min-w-0">
                <MessageResponse isAnimating={streaming && i === lastIndex} mode={streaming ? "streaming" : "static"}>
                  {part.text}
                </MessageResponse>
                {i === lastText && sources.length > 0 && (
                  <InlineCitation>
                    <InlineCitationCard sources={sources.map((s) => s.url)}>
                      <InlineCitationCarousel>
                        <InlineCitationCarouselHeader>
                          <InlineCitationCarouselPrev />
                          <InlineCitationCarouselIndex />
                          <InlineCitationCarouselNext />
                        </InlineCitationCarouselHeader>
                        {sources.map((s) => (
                          <InlineCitationCarouselItem key={s.sourceId}>
                            <InlineCitationSource title={s.title} url={s.url} />
                          </InlineCitationCarouselItem>
                        ))}
                      </InlineCitationCarousel>
                    </InlineCitationCard>
                  </InlineCitation>
                )}
              </div>
            );
          }
          if (part.type === "reasoning" && part.text) {
            return (
              <Reasoning key={i} isStreaming={streaming && part.state === "streaming"}>
                <ReasoningTrigger />
                <ReasoningContent>{part.text}</ReasoningContent>
              </Reasoning>
            );
          }
          if (isToolUIPart(part)) return <ToolCall key={i} part={part} onApprove={onApprove} />;
          return null;
        })}
        {sources.length > 0 && (
          <Sources>
            <SourcesTrigger count={sources.length} />
            <SourcesContent>
              {sources.map((s) => (
                <li key={s.sourceId}>
                  <Source href={s.url} title={s.title} />
                </li>
              ))}
            </SourcesContent>
          </Sources>
        )}
      </MessageContent>
      {actions}
    </Message>
  );
}

function ToolCall({ part, onApprove }: { part: ToolUIPart | DynamicToolUIPart; onApprove: (id: string, approved: boolean) => void }) {
  const t = useT();
  const name = getToolName(part);
  const approval = part.approval;
  // Open while it asks (you see what you approve) and on failure; otherwise a one-line summary.
  const wantsAttention = part.state === "approval-requested" || part.state === "output-error";
  const [open, setOpen] = useState(wantsAttention);
  useEffect(() => {
    if (wantsAttention) setOpen(true);
  }, [wantsAttention]);
  return (
    <Tool state={part.state} open={open} onOpenChange={setOpen}>
      <ToolHeader part={part} />
      <ToolContent>
        <ToolInput input={part.input} />
        <ToolOutput output={part.state === "output-available" ? part.output : undefined} errorText={part.state === "output-error" ? part.errorText : undefined} />
      </ToolContent>
      {approval && (
        <div className="px-3 pb-3">
          <Confirmation approval={approval} state={part.state}>
            <ConfirmationTitle>
              <ConfirmationRequest>
                {t.toolAsk(name)}
                {approval.requestReason && <span className="mt-1 block text-xs text-warn">{t.askingBecause(approval.requestReason)}</span>}
              </ConfirmationRequest>
              <ConfirmationAccepted>
                <span className="inline-flex items-center gap-1.5 text-fg-muted">
                  <ShieldCheck aria-hidden className="size-4 text-ok" />
                  {t.toolApproved}
                </span>
              </ConfirmationAccepted>
              <ConfirmationRejected>
                <span className="inline-flex items-center gap-1.5 text-fg-muted">
                  <X aria-hidden className="size-4" />
                  {t.toolRejected}
                </span>
              </ConfirmationRejected>
            </ConfirmationTitle>
            <ConfirmationActions>
              <ConfirmationAction variant="danger" onClick={() => onApprove(approval.id, false)}>
                <X aria-hidden />
                {t.deny}
              </ConfirmationAction>
              <ConfirmationAction variant="primary" onClick={() => onApprove(approval.id, true)}>
                <ShieldCheck aria-hidden />
                {t.approve}
              </ConfirmationAction>
            </ConfirmationActions>
          </Confirmation>
        </div>
      )}
    </Tool>
  );
}

/** Model picker for this chat: the chat lane's default, or any model of an enabled provider. */
function ModelPicker({ value, onChange }: { value: string | null; onChange: (value: string | null) => void }) {
  const t = useT();
  const providers = useProviders();
  const routing = useRouting();
  const [open, setOpen] = useState(false);
  const defaultRef = routing.data?.chat?.[0] ?? null;

  const groups = useMemo<ModelSelectorGroupData[]>(() => {
    const enabled = (providers.data ?? []).filter((p) => p.enabled && p.models.length > 0);
    return [
      { value: "default", label: t.defaultModel, items: [{ value: "", label: defaultRef ? t.routingDefault(splitRef(defaultRef).model) : t.defaultModel, hint: defaultRef ? splitRef(defaultRef).provider : undefined }] },
      ...enabled.map((p) => ({ value: p.id, label: p.label, items: p.models.map((m) => ({ value: `${p.id}:${m}`, label: m })) })),
    ];
  }, [providers.data, defaultRef, t]);

  const current = value ? splitRef(value).model : defaultRef ? splitRef(defaultRef).model : t.defaultModel;

  return (
    <ModelSelector
      open={open}
      onOpenChange={setOpen}
      title={t.chooseModel}
      trigger={
        <PromptInputButton aria-label={`${t.model}: ${current}`} className="max-w-56 text-fg-muted">
          <Cpu aria-hidden />
          <span className="truncate font-mono text-xs">{current}</span>
          <ChevronsUpDown aria-hidden />
        </PromptInputButton>
      }
    >
      <ModelSelectorContent groups={groups}>
        <ModelSelectorInput aria-label={t.searchModels} placeholder={t.searchModels} />
        <ModelSelectorEmpty>{t.noModelMatch}</ModelSelectorEmpty>
        <ModelSelectorList>
          {(group) => (
            <ModelSelectorGroup key={group.value} group={group}>
              {(item) => (
                <ModelSelectorItem
                  key={item.value || "default"}
                  item={item}
                  selected={(value ?? "") === item.value}
                  className="font-mono text-[0.8125rem]"
                  onSelect={(v) => {
                    onChange(v || null);
                    setOpen(false);
                  }}
                />
              )}
            </ModelSelectorGroup>
          )}
        </ModelSelectorList>
      </ModelSelectorContent>
    </ModelSelector>
  );
}
