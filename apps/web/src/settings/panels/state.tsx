import type { Settings } from "@z/core";
import type { ReactNode } from "react";
import { useSettings } from "../../api/settings.ts";
import { useT } from "../../i18n.ts";
import { Loading, LoadError } from "../../ui/card.tsx";

/** Renders `children` once the server settings are in; a spinner or a retry before that. */
export function PanelState({ children }: { children: (settings: Settings) => ReactNode }) {
  const t = useT();
  const settings = useSettings();
  if (settings.data) return children(settings.data);
  if (settings.error) return <LoadError error={settings.error} onRetry={() => void settings.refetch()} retryLabel={t.retry} />;
  return <Loading label={t.loading} className="h-32" />;
}
