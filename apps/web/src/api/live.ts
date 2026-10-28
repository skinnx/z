import type { Approval, ChannelView, ConnectorView, LiveEvent, Notice, Task } from "@z/core";
import { useEffect } from "react";
import { t } from "../i18n.ts";
import { notify } from "../ui/toast.tsx";
import { authRequired, eventsUrl, token, unreachable } from "./client.ts";
import { keys, queryClient, upsert } from "./query.ts";
import { serverText } from "../lib/server-text.ts";

const TYPES = ["task", "approval", "briefing", "channel", "channelActivity", "notice", "connector"] as const;

function apply(event: LiveEvent, go: (path: string) => void) {
  switch (event.type) {
    case "task":
      queryClient.setQueryData<Task[]>(keys.tasks, (list) => (list ? upsert(list, event.task) : list));
      break;
    case "approval": {
      const a = event.approval;
      const list = queryClient.getQueryData<Approval[]>(keys.approvals);
      const known = list?.some((x) => x.id === a.id) ?? false;
      queryClient.setQueryData<Approval[]>(keys.approvals, (prev) =>
        a.status === "pending" ? upsert(prev, a) : prev?.filter((x) => x.id !== a.id),
      );
      if (a.status === "pending" && !known) {
        notify("approval", t().newApproval, a.summary, { label: t().review, onClick: () => go("/") });
      }
      break;
    }
    case "briefing":
      queryClient.setQueryData(keys.briefing, event.briefing);
      break;
    case "channel":
      queryClient.setQueryData<ChannelView[]>(keys.channels, (list) => (list ? upsert(list, event.channel, false) : list));
      break;
    case "channelActivity":
      void queryClient.invalidateQueries({ queryKey: keys.channelActivity(event.channelId) });
      break;
    case "connector":
      queryClient.setQueryData<ConnectorView[]>(keys.connectors, (list) => (list ? upsert(list, event.connector, false) : list));
      break;
    case "notice": {
      const n = event.notice;
      const known = queryClient.getQueryData<Notice[]>(keys.notices)?.some((x) => x.id === n.id) ?? false;
      queryClient.setQueryData<Notice[]>(keys.notices, (list) => (list ? upsert(list, n) : list));
      if (n.kind === "memory") void queryClient.invalidateQueries({ queryKey: keys.memories });
      // Approvals already toast above; watch hits are the other thing worth interrupting for.
      if (n.kind === "watch" && !n.read && !known) notify("watch", serverText(n.title, n.titleMsg), serverText(n.body, n.bodyMsg), { label: t().showDetails, onClick: () => go(n.path) });
      break;
    }
  }
}

/** What the stream keeps current: missed events while it was down, refetched when it is back. */
const URGENT = [keys.approvals, keys.tasks, keys.notices];
const LIVE = [keys.briefing, keys.channels, keys.connectors, keys.memories];
const STAGGER_MS = 1500;
const fed = [...URGENT, ...LIVE];
const startsWith = (key: readonly unknown[], prefix: readonly unknown[]) => prefix.every((p, i) => key[i] === p);

/**
 * After a reconnect, refetch only what the stream would have told us about, and only what is on
 * screen: what needs the owner at once, the heavier lists a moment later. Everything else is just
 * marked stale (it can only have changed from another device) and refetches when next shown; a
 * thread or a static catalogue is left alone. Returns the timer for the second wave.
 */
function catchUp(): ReturnType<typeof setTimeout> {
  for (const queryKey of URGENT) void queryClient.invalidateQueries({ queryKey });
  void queryClient.invalidateQueries({
    refetchType: "none",
    predicate: (q) => !fed.some((k) => startsWith(q.queryKey, k)) && q.queryKey[0] !== "thread" && (q.options as { staleTime?: unknown }).staleTime !== Infinity,
  });
  return setTimeout(() => {
    for (const queryKey of LIVE) void queryClient.invalidateQueries({ queryKey });
  }, STAGGER_MS);
}

/** One EventSource for the whole app, feeding the React Query cache. `go` opens an app path from a toast. */
export function useLiveEvents(go: (path: string) => void) {
  const tok = token.use();
  useEffect(() => {
    const source = new EventSource(eventsUrl());
    const handle = (e: MessageEvent<string>) => {
      try {
        const data = JSON.parse(e.data) as LiveEvent;
        if (data && typeof data === "object" && "type" in data) apply(data, go);
      } catch {
        // ignore keep-alives and malformed frames
      }
    };
    source.onmessage = handle;
    for (const type of TYPES) source.addEventListener(type, handle);
    let opened = false;
    let later: ReturnType<typeof setTimeout> | undefined;
    source.onopen = () => {
      unreachable.set(false);
      if (opened) later = catchUp();
      opened = true;
    };
    // The browser retries on its own; until then the shell says the server can't be reached.
    source.onerror = () => {
      // (A missing token fails the stream too; the token dialog covers that.)
      if (source.readyState !== EventSource.OPEN && !authRequired.get()) unreachable.set(true);
    };
    return () => {
      clearTimeout(later);
      source.close();
    };
  }, [tok, go]);
}
