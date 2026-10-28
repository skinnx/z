/**
 * What each screen needs before it can paint: its code chunk and the queries it reads on mount.
 * The router's loaders start both together on navigation (instead of the data waiting for the chunk
 * to load and render), and nav links start them on hover, focus or touch, so a click usually finds
 * them ready. Fresh cached data is never refetched (`prefetchQuery` honours `staleTime`).
 */
import type { ConnectorPreset, ConnectorView, Task } from "@z/core";
import type { FetchQueryOptions } from "@tanstack/react-query";
import { briefingQuery } from "../api/briefing.ts";
import { adaptersQuery, channelsQuery } from "../api/channels.ts";
import { api } from "../api/client.ts";
import { memoriesQuery } from "../api/memories.ts";
import { pluginsQuery } from "../api/plugins.ts";
import { providersQuery, routingQuery } from "../api/providers.ts";
import { keys, queryClient } from "../api/query.ts";
import { settingsQuery } from "../api/settings.ts";
import { skillsQuery } from "../api/skills.ts";
import { prefetchThread, threadsQuery, type ThreadSummary } from "../api/threads.ts";

// The same queries as useTasks / useConnectors / useConnectorPresets (api/tasks.ts, api/connectors.ts).
const tasksQuery = { queryKey: keys.tasks, queryFn: () => api<Task[]>("/tasks") };
export const connectorsQuery = { queryKey: keys.connectors, queryFn: () => api<ConnectorView[]>("/connectors") };
const presetsQuery = { queryKey: keys.connectorPresets, queryFn: () => api<ConnectorPreset[]>("/connector-presets"), staleTime: Infinity };

export const chunks = {
  today: () => import("../routes/today.tsx"),
  chat: () => import("../routes/chat.tsx"),
  tasks: () => import("../routes/tasks.tsx"),
  channels: () => import("../routes/channels.tsx"),
  models: () => import("../routes/models.tsx"),
  plugins: () => import("../routes/plugins.tsx"),
  connect: () => import("../routes/connect.tsx"),
};
type Screen = keyof typeof chunks;

// Today's setup checklist is left out: it is always refetched on mount (staleTime 0).
const data: Record<Screen, FetchQueryOptions<any, any, any, any>[]> = {
  today: [briefingQuery, memoriesQuery, providersQuery, tasksQuery, settingsQuery],
  chat: [threadsQuery, providersQuery, routingQuery, pluginsQuery, skillsQuery, connectorsQuery],
  tasks: [tasksQuery, providersQuery, routingQuery, settingsQuery],
  channels: [channelsQuery, adaptersQuery, settingsQuery],
  models: [providersQuery, routingQuery],
  plugins: [pluginsQuery],
  connect: [connectorsQuery, presetsQuery, settingsQuery],
};

const SCREENS: Record<string, Screen> = {
  "": "today",
  chat: "chat",
  tasks: "tasks",
  channels: "channels",
  models: "models",
  plugins: "plugins",
  connect: "connect",
};

/** Start loading a screen's chunk and data, and the chat thread `threadId` if given. */
export function prefetchScreen(screen: Screen, threadId?: string) {
  void chunks[screen]().catch(() => {}); // a chunk that fails shows the route error once rendered
  for (const query of data[screen]) void queryClient.prefetchQuery(query);
  if (screen === "chat" && threadId) prefetchThread(threadId);
}

/** New threads get their id in the browser, so only one the list has is worth asking the server for. */
export function isKnownThread(id: string): boolean {
  return queryClient.getQueryData<ThreadSummary[]>(keys.threads)?.some((t) => t.id === id) ?? false;
}

/** Prefetch for an app path (`/connect`, `/chat/abc`); unknown paths are ignored. */
export function prefetchPath(path: string) {
  const [first = "", second] = path.replace(/[?#].*$/, "").split("/").filter(Boolean);
  const screen = SCREENS[first];
  if (!screen) return;
  let id: string | undefined;
  try {
    id = second === undefined ? undefined : decodeURIComponent(second);
  } catch {}
  prefetchScreen(screen, id && isKnownThread(id) ? id : undefined);
}

/** Handlers for a link: prefetch on hover, keyboard focus or the start of a touch. */
export function intentProps(path: string) {
  const go = () => prefetchPath(path);
  return { onPointerEnter: go, onFocus: go, onTouchStart: go };
}
