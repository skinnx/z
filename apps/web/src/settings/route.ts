/** Settings open over any screen, addressed by `?settings=<section>`. */
import { Bell, Cable, Database, Lock, RadioTower, Settings2, ShieldCheck, Sparkles, SquareSlash, type LucideIcon } from "lucide-react";
import { useCallback, useMemo } from "react";
import { useLocation, useNavigate, type Location } from "react-router";
import type { Dict } from "../i18n.ts";

export const SECTIONS = ["general", "personalization", "skills", "notifications", "reach", "sources", "approvals", "data", "security"] as const;
export type SectionId = (typeof SECTIONS)[number];

export const sectionIcon: Record<SectionId, LucideIcon> = {
  general: Settings2,
  personalization: Sparkles,
  skills: SquareSlash,
  notifications: Bell,
  reach: RadioTower,
  sources: Cable,
  approvals: ShieldCheck,
  data: Database,
  security: Lock,
};

export const sectionLabel = (t: Dict, id: SectionId): string => t[`set_${id}`];

export const isSection = (v: string | null): v is SectionId => SECTIONS.includes(v as SectionId);

const PARAM = "settings";
/** Set on the history entry we pushed to open settings, so closing can pop it (Back closes too). */
type State = { settingsPushed?: true } | null;

/** Where focus goes back to when settings close. */
let opener: HTMLElement | null = null;
export const settingsOpener = () => (opener?.isConnected ? opener : document.getElementById("main"));

function withParam(location: Location, value: string | null) {
  const params = new URLSearchParams(location.search);
  if (value === null) params.delete(PARAM);
  else params.set(PARAM, value);
  const search = params.toString();
  return { pathname: location.pathname, search: search ? `?${search}` : "", hash: location.hash };
}

export function useSettingsRoute() {
  const location = useLocation();
  const navigate = useNavigate();
  const raw = new URLSearchParams(location.search).get(PARAM);
  const state = location.state as State;
  const pushed = !!state?.settingsPushed;

  /** Open at a section (or the list on phones). Opening pushes one entry; moving between sections replaces it. */
  const open = useCallback(
    (section?: SectionId) => {
      if (raw === null) {
        opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
        void navigate(withParam(location, section ?? ""), { state: { ...(state ?? {}), settingsPushed: true } });
      } else void navigate(withParam(location, section ?? ""), { replace: true, state });
    },
    [raw, location, state, navigate],
  );

  const close = useCallback(() => {
    if (raw === null) return;
    if (pushed) void navigate(-1);
    else {
      const { settingsPushed: _, ...rest } = state ?? {};
      void navigate(withParam(location, null), { replace: true, state: rest });
    }
  }, [raw, pushed, state, location, navigate]);

  /** Leave settings for another screen; Back then returns to where settings were opened. */
  const leave = useCallback((path: string) => void navigate(path, { replace: pushed }), [pushed, navigate]);

  return useMemo(
    () => ({ isOpen: raw !== null, section: isSection(raw) ? raw : null, open, close, leave }),
    [raw, open, close, leave],
  );
}
