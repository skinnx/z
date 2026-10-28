import type { BriefItem, ChannelKind, Lane, Notice, Risk, TaskStatus } from "@z/core";
import {
  AtSign,
  Ban,
  Bot,
  Brain,
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
  MessageCircleQuestion,
  OctagonAlert,
  PauseCircle,
  ClipboardCheck,
  LoaderCircle,
  MessageSquare,
  Newspaper,
  PenLine,
  Radar,
  Reply,
  Send,
  ShieldAlert,
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

export const noticeKindIcon: Record<Notice["kind"], LucideIcon> = {
  approval: ShieldAlert,
  watch: Radar,
  // Neutral: how a run ended comes from `Notice.status` (see NoticeIcon).
  task: ListTodo,
  briefing: Sunrise,
  memory: Brain,
  question: MessageCircleQuestion,
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
  needs_input: [MessageCircleQuestion, "text-warn"],
  review: [ClipboardCheck, "text-accent-text"],
  interrupted: [OctagonAlert, "text-danger"],
  paused: [PauseCircle, "text-warn"],
};

/** A notice's icon: a task notice shows how its run ended (a failure is never a check mark); others show their kind. */
export function NoticeIcon({ notice: n, t, className }: { notice: Notice; t: Dict; className?: string }) {
  if (n.kind === "task" && n.status) return <StatusIcon status={n.status} t={t} className={className} />;
  const Icon = noticeKindIcon[n.kind];
  return <Icon role="img" aria-label={t[`notice_${n.kind}`]} className={cn("size-4 shrink-0", n.read ? "text-fg-muted" : "text-accent-text", className)} />;
}

/** The server words task-notice titles in English ("Failed · <task>"); say the outcome in the owner's language. */
export function noticeTitle(n: Notice, t: Dict): string {
  if (n.kind !== "task" || !n.status) return n.title;
  const sep = n.title.indexOf(" · ");
  return `${t[`status_${n.status}`]} · ${sep === -1 ? n.title : n.title.slice(sep + 3)}`;
}

export function StatusIcon({ status, t, className }: { status: TaskStatus; t: Dict; className?: string }) {
  const [Icon, tone] = statusIcons[status];
  return <Icon role="img" aria-label={t[`status_${status}`]} className={cn("size-5 shrink-0", tone, className)} />;
}

export function RiskIcon({ risk, t, className }: { risk: Risk; t: Dict; className?: string }) {
  const Icon = riskIcon[risk];
  return <Icon role="img" aria-label={t[`risk_${risk}`]} className={cn("size-4 shrink-0", riskTone[risk], className)} />;
}
