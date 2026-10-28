import "./app.css";
import "./lib/theme.ts";
import { QueryClientProvider } from "@tanstack/react-query";
import { lazy, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Navigate, useParams } from "react-router";
import { RouterProvider } from "react-router/dom";
import { queryClient } from "./api/query.ts";
import { startPwa } from "./lib/pwa.ts";
import { isSection } from "./settings/route.ts";
import { Shell } from "./shell/shell.tsx";
import { Toaster } from "./ui/toast.tsx";
import { TooltipProvider } from "./ui/tooltip.tsx";

const Today = lazy(() => import("./routes/today.tsx"));
const Chat = lazy(() => import("./routes/chat.tsx"));
const Tasks = lazy(() => import("./routes/tasks.tsx"));
const Channels = lazy(() => import("./routes/channels.tsx"));
const Models = lazy(() => import("./routes/models.tsx"));
const Plugins = lazy(() => import("./routes/plugins.tsx"));
const Connect = lazy(() => import("./routes/connect.tsx"));

function SettingsRedirect() {
  const { section } = useParams();
  return <Navigate to={`/?settings=${isSection(section ?? null) ? section : "general"}`} replace />;
}

const router = createBrowserRouter([
  {
    path: "/",
    element: <Shell />,
    children: [
      { index: true, element: <Today /> },
      { path: "chat/:id?", element: <Chat /> },
      { path: "tasks", element: <Tasks /> },
      // Settings open over any screen (`?settings=<section>`); the old pages land on Today with them open.
      { path: "settings/:section?", element: <SettingsRedirect /> },
      { path: "memory", element: <Navigate to="/?settings=personalization" replace /> },
      { path: "channels", element: <Channels /> },
      { path: "models", element: <Models /> },
      { path: "connect", element: <Connect /> },
      { path: "plugins", element: <Plugins /> },
      { path: "*", element: <Navigate to="/" replace /> },
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
