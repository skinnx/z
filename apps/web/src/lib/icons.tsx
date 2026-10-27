import type { BriefItem, ChannelKind, Lane, Risk, TaskStatus } from "@z/core";
import {
  AtSign,
  Ban,
  Bot,
  CalendarClock,
  CircleCheck,
  CircleX,
  Clock,
  Eye,
  Gamepad2,
  Globe,
  Hash,
  Hand,
  ListTodo,
  LoaderCircle,
  MessageSquare,
  Newspaper,
  PenLine,
  Reply,
  Send,
  Sunrise,
  TrendingUp,
  Webhook,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type { Dict } from "../i18n.ts";
import { cn } from "./cn.ts";

export const riskIcon: Record<Risk, LucideIcon> = { read: Eye, write: PenLine, external: Globe };
export const riskTone: Record<Risk, string> = { read: "text-fg-muted", write: "text-warn", external: "text-danger" };

export const channelIcon: Record<ChannelKind, LucideIcon> = {
  webhook: Webhook,
  telegram: Send,
  discord: Gamepad2,
  slack: Hash,
  x: AtSign,
};

export const laneIcon: Record<Lane, LucideIcon> = {
  chat: MessageSquare,
  agent: Bot,
  briefing: Sunrise,
  bot: AtSign,
  fast: Zap,
};

export const briefKindIcon: Record<BriefItem["kind"], LucideIcon> = {
  headline: Newspaper,
  todo: ListTodo,
  followup: Reply,
  metric: TrendingUp,
};

const statusIcons: Record<TaskStatus, [LucideIcon, string]> = {
  queued: [Clock, "text-fg-muted"],
  running: [LoaderCircle, "text-accent-text motion-safe:animate-spin"],
  waiting: [Hand, "text-warn"],
  scheduled: [CalendarClock, "text-accent-text"],
  done: [CircleCheck, "text-ok"],
  failed: [CircleX, "text-danger"],
  cancelled: [Ban, "text-fg-muted"],
};

export function StatusIcon({ status, t, className }: { status: TaskStatus; t: Dict; className?: string }) {
  const [Icon, tone] = statusIcons[status];
  return <Icon role="img" aria-label={t[`status_${status}`]} className={cn("size-5 shrink-0", tone, className)} />;
}

export function RiskIcon({ risk, t, className }: { risk: Risk; t: Dict; className?: string }) {
  const Icon = riskIcon[risk];
  return <Icon role="img" aria-label={t[`risk_${risk}`]} className={cn("size-4 shrink-0", riskTone[risk], className)} />;
}
