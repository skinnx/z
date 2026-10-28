import { Command, Ellipsis, Settings, SunMoon } from "lucide-react";
import { Suspense, useCallback } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { useNeedsYou } from "../api/needs.ts";
import { useLiveEvents } from "../api/live.ts";
import { useOwnerDefaults } from "../api/owner-defaults.ts";
import { useT } from "../i18n.ts";
import { cn } from "../lib/cn.ts";
import { toggleTheme } from "../lib/theme.ts";
import { Button } from "../ui/button.tsx";
import { Kbd, Spinner } from "../ui/card.tsx";
import { IconButton } from "../ui/icon-button.tsx";
import { Menu, MenuItem, MenuLinkItem, MenuSeparator } from "../ui/menu.tsx";
import { CommandMenu, commandMenuOpen } from "./command-menu.tsx";
import { NoticeBell, NoticeTab } from "./notices.tsx";
import { NAV } from "./nav.ts";
import { OfflineBar } from "./offline.tsx";
import { TokenDialog } from "./token-dialog.tsx";
import { SettingsHost } from "../settings/host.tsx";
import { useSettingsRoute } from "../settings/route.ts";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

function Logo() {
  return (
    <span aria-hidden className="grid size-8 place-items-center rounded-lg bg-accent font-mono text-base font-bold text-accent-fg">
      z
    </span>
  );
}

function PendingBadge({ count, label }: { count: number; label: string }) {
  if (!count) return null;
  return (
    <span className="ms-auto grid h-5 min-w-5 place-items-center rounded-full bg-accent px-1.5 text-[0.6875rem] font-semibold tabular-nums text-accent-fg">
      <span aria-hidden>{count}</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

export function Shell() {
  const t = useT();
  const navigate = useNavigate();
  const location = useLocation();
  // One count for everything waiting on the owner, the same as Today's "Needs you".
  const pending = useNeedsYou().count;
  const go = useCallback((path: string) => navigate(path), [navigate]);
  useLiveEvents(go);
  useOwnerDefaults();
  const settings = useSettingsRoute();
  const isChat = location.pathname.startsWith("/chat");
  const morePaths = NAV.filter((n) => !n.primary).map((n) => n.to);
  const moreActive = morePaths.some((p) => location.pathname.startsWith(p));

  return (
    <div className="flex min-h-dvh">
      <a
        href="#main"
        className="sr-only z-[70] rounded-lg bg-accent px-4 py-2 text-accent-fg focus:not-sr-only focus:fixed focus:start-4 focus:top-4"
      >
        {t.skipToContent}
      </a>

      {/* Wide screens: sidebar */}
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col gap-1 border-e border-line bg-bg px-3 py-4 md:flex">
        <div className="mb-4 flex items-center justify-between ps-2">
          <Logo />
          <span className="sr-only">z</span>
          <div className="flex items-center">
            <NoticeBell />
            <IconButton label={t.toggleTheme} onClick={toggleTheme} className="text-fg-muted">
              <SunMoon aria-hidden />
            </IconButton>
          </div>
        </div>
        <nav aria-label={t.mainNav} className="flex flex-col gap-0.5">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === "/"}
              className={({ isActive }) =>
                cn(
                  "flex h-10 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors",
                  isActive ? "bg-surface text-fg ring-1 ring-line" : "text-fg-muted hover:bg-subtle hover:text-fg",
                )
              }
            >
              <n.icon aria-hidden className="size-[1.125rem]" />
              {t[n.label]}
              {n.to === "/" && <PendingBadge count={pending} label={t.pendingCount(pending)} />}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto flex flex-col gap-0.5">
          <Button
            variant="ghost"
            className={cn("w-full justify-start px-3", settings.isOpen ? "bg-surface text-fg ring-1 ring-line" : "text-fg-muted")}
            onClick={() => settings.open()}
          >
            <Settings aria-hidden />
            <span className="min-w-0 flex-1 truncate text-start">{t.nav_settings}</span>
            <Kbd>{isMac ? "⌘," : "Ctrl ,"}</Kbd>
          </Button>
          <Button variant="ghost" className="w-full justify-start px-3 text-fg-muted" onClick={() => commandMenuOpen.set(true)}>
            <Command aria-hidden />
            <span className="min-w-0 flex-1 truncate text-start">{t.commandMenu}</span>
            <Kbd>{isMac ? "⌘K" : "Ctrl K"}</Kbd>
          </Button>
        </div>
      </aside>

      <main id="main" tabIndex={-1} className={cn("min-w-0 flex-1 outline-none", !isChat && "pb-24 md:pb-0")}>
        <OfflineBar />
        <Suspense
          fallback={
            <div className="grid h-64 place-items-center text-fg-muted" role="status">
              <Spinner />
              <span className="sr-only">{t.loading}</span>
            </div>
          }
        >
          <Outlet />
        </Suspense>
      </main>

      {/* Small screens: bottom tab bar */}
      <nav
        aria-label={t.mainNav}
        className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-6 border-t border-line bg-bg/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
      >
        {NAV.filter((n) => n.primary).map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.to === "/"}
            className={({ isActive }) =>
              cn(
                "relative flex h-16 flex-col items-center justify-center gap-1 text-[0.6875rem] font-medium",
                isActive ? "text-accent-text" : "text-fg-muted",
              )
            }
          >
            <span className="relative">
              <n.icon aria-hidden className="size-6" />
              {n.to === "/" && pending > 0 && (
                <span aria-hidden className="absolute -end-1.5 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-accent px-1 text-[0.625rem] font-semibold text-accent-fg">
                  {pending}
                </span>
              )}
            </span>
            {t[n.label]}
            {n.to === "/" && pending > 0 && <span className="sr-only">{t.pendingCount(pending)}</span>}
          </NavLink>
        ))}
        <NoticeTab className="relative flex h-16 flex-col items-center justify-center gap-1 text-[0.6875rem] font-medium text-fg-muted" />
        <Menu
          side="top"
          trigger={
            <button
              type="button"
              className={cn("flex h-16 flex-col items-center justify-center gap-1 text-[0.6875rem] font-medium", moreActive ? "text-accent-text" : "text-fg-muted")}
            >
              <Ellipsis aria-hidden className="size-6" />
              {t.more}
            </button>
          }
        >
          {NAV.filter((n) => !n.primary).map((n) => (
            <MenuLinkItem key={n.to} icon={<n.icon aria-hidden />} render={<NavLink to={n.to} />}>
              {t[n.label]}
            </MenuLinkItem>
          ))}
          <MenuItem icon={<Settings aria-hidden />} onClick={() => settings.open()}>
            {t.nav_settings}
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon={<Command aria-hidden />} onClick={() => commandMenuOpen.set(true)}>
            {t.commandMenu}
          </MenuItem>
          <MenuItem icon={<SunMoon aria-hidden />} onClick={toggleTheme}>
            {t.toggleTheme}
          </MenuItem>
        </Menu>
      </nav>

      <CommandMenu />
      <SettingsHost />
      <TokenDialog />
    </div>
  );
}
