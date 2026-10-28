import { useEffect, useRef } from "react";
import { locale } from "../i18n.ts";
import { deviceZone } from "../lib/timezones.ts";
import { useSaveSetting, useSettings, type SettingsPatch } from "./settings.ts";

/**
 * Once per load: a server that never had a time zone chosen takes this device's (schedules and the
 * briefing would otherwise run on UTC), and the language syncs both ways: the server learns the first
 * browser's, a browser without its own choice takes the server's.
 */
export function useOwnerDefaults() {
  const settings = useSettings();
  const { save } = useSaveSetting();
  const done = useRef(false);
  useEffect(() => {
    const s = settings.data;
    if (!s || done.current) return;
    done.current = true;
    const patch: SettingsPatch = {};
    const device = deviceZone();
    if (!s.timezoneSet && s.timezone === "UTC" && device !== "UTC") patch.timezone = device;
    if (s.language === null) patch.language = locale.get();
    else if (!locale.chosen() && s.language !== locale.get()) locale.set(s.language);
    if (Object.keys(patch).length) save(patch);
  }, [settings.data, save]);
}
