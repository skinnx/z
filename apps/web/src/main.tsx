import "./app.css";
import "./lib/theme.ts";
import { QueryClientProvider } from "@tanstack/react-query";
import { lazy, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Navigate } from "react-router";
import { RouterProvider } from "react-router/dom";
import { queryClient } from "./api/query.ts";
import { Shell } from "./shell/shell.tsx";
import { Toaster } from "./ui/toast.tsx";
import { TooltipProvider } from "./ui/tooltip.tsx";

const Today = lazy(() => import("./routes/today.tsx"));
const Chat = lazy(() => import("./routes/chat.tsx"));
const Tasks = lazy(() => import("./routes/tasks.tsx"));
const Channels = lazy(() => import("./routes/channels.tsx"));
const Models = lazy(() => import("./routes/models.tsx"));
const Plugins = lazy(() => import("./routes/plugins.tsx"));
const SettingsRoute = lazy(() => import("./routes/settings.tsx"));

const router = createBrowserRouter([
  {
    path: "/",
    element: <Shell />,
    children: [
      { index: true, element: <Today /> },
      { path: "chat/:id?", element: <Chat /> },
      { path: "tasks", element: <Tasks /> },
      { path: "channels", element: <Channels /> },
      { path: "models", element: <Models /> },
      { path: "plugins", element: <Plugins /> },
      { path: "settings", element: <SettingsRoute /> },
      { path: "*", element: <Navigate to="/" replace /> },
    ],
  },
]);

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
