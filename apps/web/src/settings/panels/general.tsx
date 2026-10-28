import type { Settings } from "@z/core";
import { ArrowUpRight, AtSign, Clock, Languages, Monitor, Moon, Sun } from "lucide-react";
import { useMemo } from "react";
import { useSaveSetting, useSettings } from "../../api/settings.ts";
import { locale, useT, type Locale } from "../../i18n.ts";
import { isValidCron, parseCron } from "../../lib/cron.ts";
import { theme, type ThemePref } from "../../lib/theme.ts";
import { Button } from "../../ui/button.tsx";
import { Combobox } from "../../ui/combobox.tsx";
import { Input } from "../../ui/field.tsx";
import { Row, RowGroup, useAutosaveText } from "../../ui/row.tsx";
import { Select } from "../../ui/select.tsx";
import { Segmented } from "../../ui/toggle-group.tsx";
import { useSettingsRoute } from "../route.ts";
import { PanelState } from "./state.tsx";

export function GeneralPanel() {
  const t = useT();
  const route = useSettingsRoute();
  return (
    <>
      <RowGroup>
        <ThemeRow />
        <LanguageRow />
        <PanelState>{(s) => <AgentRows settings={s} />}</PanelState>
      </RowGroup>
      <RowGroup label={t.workspaces}>
        <Row label={t.nav_models} hint={t.modelsHint}>
          {({ labelId }) => (
            <Button size="sm" aria-describedby={labelId} onClick={() => route.leave("/models")}>
              {t.open}
              <ArrowUpRight aria-hidden className="rtl:-scale-x-100" />
            </Button>
          )}
        </Row>
        <Row label={t.nav_channels} hint={t.channelsHint}>
          {({ labelId }) => (
            <Button size="sm" aria-describedby={labelId} onClick={() => route.leave("/channels")}>
              {t.open}
              <ArrowUpRight aria-hidden className="rtl:-scale-x-100" />
            </Button>
          )}
        </Row>
      </RowGroup>
    </>
  );
}

function ThemeRow() {
  const t = useT();
  const pref = theme.use();
  return (
    <Row label={t.theme}>
      {() => (
        <Segmented<ThemePref>
          label={t.theme}
          value={pref}
          onChange={(v) => theme.set(v === "system" ? null : v)}
          options={[
            { value: "system", label: t.th_system, icon: <Monitor aria-hidden /> },
            { value: "light", label: t.th_light, icon: <Sun aria-hidden /> },
            { value: "dark", label: t.th_dark, icon: <Moon aria-hidden /> },
          ]}
        />
      )}
    </Row>
  );
}

function LanguageRow() {
  const t = useT();
  const lang = locale.use();
  return (
    <Row label={t.language}>
      {({ labelId }) => (
        <Select<Locale>
          aria-labelledby={labelId}
          value={lang}
          onChange={(v) => locale.set(v)}
          className="w-44"
          options={[
            { value: "en", label: "English", icon: <Languages aria-hidden /> },
            { value: "vi", label: "Tiếng Việt", icon: <Languages aria-hidden /> },
          ]}
        />
      )}
    </Row>
  );
}

function AgentRows({ settings }: { settings: Settings }) {
  return (
    <>
      <HandleRow value={settings.handle} />
      <TimezoneRow value={settings.timezone} />
      <BriefingRow cron={settings.briefingCron} />
    </>
  );
}

function HandleRow({ value }: { value: string }) {
  const t = useT();
  const { save, saved } = useSaveSetting();
  const text = useAutosaveText(value, (v) => {
    const handle = v.trim().replace(/^@+/, "");
    if (handle && handle.length <= 32) save({ handle });
  });
  const invalid = !text.draft.trim().replace(/^@+/, "");
  return (
    <Row label={t.handle} hint={invalid ? <span className="text-danger">{t.handleRequired}</span> : t.handleHint(text.draft.trim() || value)} saved={saved}>
      {({ labelId, hintId }) => (
        <div className="relative w-44">
          <AtSign aria-hidden className="pointer-events-none absolute start-3 top-3 size-4 text-fg-muted" />
          <Input
            aria-labelledby={labelId}
            aria-describedby={hintId}
            aria-invalid={invalid || undefined}
            value={text.draft}
            onValueChange={text.change}
            onBlur={text.flush}
            maxLength={32}
            spellCheck={false}
            autoCapitalize="off"
            className="ps-9"
          />
        </div>
      )}
    </Row>
  );
}

function TimezoneRow({ value }: { value: string }) {
  const t = useT();
  const { save, saved } = useSaveSetting();
  const zones = useMemo(() => {
    const list = Intl.supportedValuesOf("timeZone");
    return list.includes("UTC") ? list : ["UTC", ...list];
  }, []);
  return (
    <Row label={t.timezone} saved={saved}>
      {({ labelId }) => (
        <Combobox
          aria-labelledby={labelId}
          items={zones}
          value={value}
          onChange={(tz) => tz && tz !== value && save({ timezone: tz })}
          emptyText={t.noResults}
          placeholder="UTC"
          className="w-56"
        />
      )}
    </Row>
  );
}

/** Daily time when the cron is one this UI writes; the raw expression otherwise. */
function BriefingRow({ cron }: { cron: string }) {
  const t = useT();
  const { save, saved } = useSaveSetting();
  const parsed = parseCron(cron);
  const custom = parsed.preset !== "daily";
  const time = useAutosaveText(parsed.time, (hhmm) => {
    const [h, m] = hhmm.split(":").map(Number);
    if (Number.isInteger(h) && Number.isInteger(m)) save({ briefingCron: `${m} ${h} * * *` });
  });
  const expr = useAutosaveText(cron, (v) => isValidCron(v) && save({ briefingCron: v.trim() }));
  return (
    <Row label={t.briefingTime} hint={custom ? t.cronExpr : undefined} saved={saved}>
      {({ labelId, hintId }) =>
        custom ? (
          <Input
            aria-labelledby={labelId}
            aria-describedby={hintId}
            value={expr.draft}
            onValueChange={expr.change}
            onBlur={expr.flush}
            spellCheck={false}
            className="w-44 font-mono text-sm"
          />
        ) : (
          <div className="relative w-40">
            <Clock aria-hidden className="pointer-events-none absolute start-3 top-3 size-4 text-fg-muted" />
            <Input type="time" required aria-labelledby={labelId} value={time.draft} onValueChange={time.change} onBlur={time.flush} className="ps-9" />
          </div>
        )
      }
    </Row>
  );
}
