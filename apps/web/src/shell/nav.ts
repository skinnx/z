import { Blocks, House, KeyRound, ListChecks, MessageSquare, RadioTower, Settings, type LucideIcon } from "lucide-react";
import type { Dict } from "../i18n.ts";

export type NavItem = { to: string; label: keyof Dict & `nav_${string}`; icon: LucideIcon; primary: boolean };

/** `primary` items live in the mobile tab bar; the rest go under "More". */
export const NAV: NavItem[] = [
  { to: "/", label: "nav_today", icon: House, primary: true },
  { to: "/chat", label: "nav_chat", icon: MessageSquare, primary: true },
  { to: "/tasks", label: "nav_tasks", icon: ListChecks, primary: true },
  { to: "/models", label: "nav_models", icon: KeyRound, primary: true },
  { to: "/channels", label: "nav_channels", icon: RadioTower, primary: false },
  { to: "/plugins", label: "nav_plugins", icon: Blocks, primary: false },
  { to: "/settings", label: "nav_settings", icon: Settings, primary: false },
];
