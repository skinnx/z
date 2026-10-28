import "./app.css";
import "./lib/theme.ts";
import { QueryClientProvider } from "@tanstack/react-query";
import { lazy, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Navigate, useParams, type LoaderFunctionArgs, type ShouldRevalidateFunction } from "react-router";
import { RouterProvider } from "react-router/dom";
import { queryClient } from "./api/query.ts";
import { startPwa } from "./lib/pwa.ts";
import { isSection } from "./settings/route.ts";
import { RootError, RouteError } from "./shell/offline.tsx";
import { chunks, isKnownThread, prefetchScreen } from "./shell/prefetch.ts";
import { Shell } from "./shell/shell.tsx";
import { Toaster } from "./ui/toast.tsx";
import { TooltipProvider } from "./ui/tooltip.tsx";

const Today = lazy(chunks.today);
const Chat = lazy(chunks.chat);
const Tasks = lazy(chunks.tasks);
const Channels = lazy(chunks.channels);
const Models = lazy(chunks.models);
const Plugins = lazy(chunks.plugins);
const Connect = lazy(chunks.connect);

/**
 * Loaders only start the screen's chunk and queries, in parallel, and never wait for them: the
 * screen renders at once and reads the queries as usual (shell/prefetch.ts).
 */
let firstLoad = true;
const load =
  (screen: Parameters<typeof prefetchScreen>[0]) =>
  ({ params }: LoaderFunctionArgs) => {
    // On the first load the thread list isn't in yet; a thread in the address is worth fetching.
    const thread = params.id && (firstLoad || isKnownThread(params.id)) ? params.id : undefined;
    firstLoad = false;
    prefetchScreen(screen, thread);
    return null;
  };
// Search params (?settings=, ?task=) don't change what a screen loads.
const samePath: ShouldRevalidateFunction = ({ currentUrl, nextUrl }) => currentUrl.pathname !== nextUrl.pathname;
const screen = (s: Parameters<typeof prefetchScreen>[0]) => ({ loader: load(s), shouldRevalidate: samePath });

function SettingsRedirect() {
  const { section } = useParams();
  return <Navigate to={`/?settings=${isSection(section ?? null) ? section : "general"}`} replace />;
}

const router = createBrowserRouter([
  {
    path: "/",
    element: <Shell />,
    errorElement: <RootError />,
    children: [
      {
        // A screen that fails (e.g. its chunk can't load offline or after a redeploy) shows inside the shell.
        errorElement: <RouteError />,
        children: [
          { index: true, element: <Today />, ...screen("today") },
          { path: "chat/:id?", element: <Chat />, ...screen("chat") },
          { path: "tasks", element: <Tasks />, ...screen("tasks") },
          // Settings open over any screen (`?settings=<section>`); the old pages land on Today with them open.
          { path: "settings/:section?", element: <SettingsRedirect /> },
          { path: "memory", element: <Navigate to="/?settings=personalization" replace /> },
          { path: "channels", element: <Channels />, ...screen("channels") },
          { path: "models", element: <Models />, ...screen("models") },
          { path: "connect", element: <Connect />, ...screen("connect") },
          { path: "plugins", element: <Plugins />, ...screen("plugins") },
          { path: "*", element: <Navigate to="/" replace /> },
        ],
      },
    ],
  },
]);

startPwa((path) => void router.navigate(path));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delay={400}>
        <Toaster>
          <RouterProvider router={router} />
        </Toaster>
      </TooltipProvider>
    </QueryClientProvider>
  </StrictMode>,
);
