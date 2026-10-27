import type { Approval, ChannelView, LiveEvent, Task } from "@z/core";
import { useEffect } from "react";
import { t } from "../i18n.ts";
import { notify } from "../ui/toast.tsx";
import { eventsUrl, token } from "./client.ts";
import { keys, queryClient, upsert } from "./query.ts";

const TYPES = ["task", "approval", "briefing", "channel"] as const;

function apply(event: LiveEvent, onReview: () => void) {
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
        notify("approval", t().newApproval, a.summary, { label: t().review, onClick: onReview });
      }
      break;
    }
    case "briefing":
      queryClient.setQueryData(keys.briefing, event.briefing);
      break;
    case "channel":
      queryClient.setQueryData<ChannelView[]>(keys.channels, (list) => (list ? upsert(list, event.channel, false) : list));
      break;
  }
}

/** One EventSource for the whole app, feeding the React Query cache. */
export function useLiveEvents(onReview: () => void) {
  const tok = token.use();
  useEffect(() => {
    const source = new EventSource(eventsUrl());
    const handle = (e: MessageEvent<string>) => {
      try {
        const data = JSON.parse(e.data) as LiveEvent;
        if (data && typeof data === "object" && "type" in data) apply(data, onReview);
      } catch {
        // ignore keep-alives and malformed frames
      }
    };
    source.onmessage = handle;
    for (const type of TYPES) source.addEventListener(type, handle);
    // After a reconnect, anything may have changed while we were away.
    let opened = false;
    source.onopen = () => {
      if (opened) void queryClient.invalidateQueries();
      opened = true;
    };
    return () => source.close();
  }, [tok, onReview]);
}
