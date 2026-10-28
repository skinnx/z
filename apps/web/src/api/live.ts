import type { Approval, ChannelView, ConnectorView, LiveEvent, Notice, Task } from "@z/core";
import { useEffect } from "react";
import { t } from "../i18n.ts";
import { notify } from "../ui/toast.tsx";
import { authRequired, eventsUrl, token, unreachable } from "./client.ts";
import { keys, queryClient, upsert } from "./query.ts";

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
      if (n.kind === "watch" && !n.read && !known) notify("watch", n.title, n.body, { label: t().showDetails, onClick: () => go(n.path) });
      break;
    }
  }
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
    // After a reconnect, anything may have changed while we were away.
    let opened = false;
    source.onopen = () => {
      unreachable.set(false);
      if (opened) void queryClient.invalidateQueries();
      opened = true;
    };
    // The browser retries on its own; until then the shell says the server can't be reached.
    source.onerror = () => {
      // (A missing token fails the stream too; the token dialog covers that.)
      if (source.readyState !== EventSource.OPEN && !authRequired.get()) unreachable.set(true);
    };
    return () => source.close();
  }, [tok, go]);
}
