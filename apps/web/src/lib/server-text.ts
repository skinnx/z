/**
 * Text the server wrote itself arrives as English plus a message key (`…Msg`, core contract/messages.ts).
 * These word the key in the app's language and fall back to the English when there is no key, or one
 * this build doesn't know yet (a newer server).
 *
 *   const st = useServerText();
 *   st(row.detail, row.detailMsg)
 */
import { useCallback } from "react";
import { wordServerText, type ServerText } from "@z/core/messages";
import { locale, type Locale } from "../i18n.ts";
import * as server from "../i18n/server.ts";

const dicts: Record<Locale, Parameters<typeof wordServerText>[1]> = { en: server.en, vi: server.vi };

/** For code outside React (toasts, error text). */
export function serverText(fallback: string, msg?: ServerText | null, lang: Locale = locale.get()): string {
  if (!msg) return fallback;
  return wordServerText(msg, dicts[lang]) ?? fallback;
}

/** `st(english, msg)` in the current language; re-renders when the language changes. */
export function useServerText(): (fallback: string, msg?: ServerText | null) => string {
  const lang = locale.use();
  return useCallback((fallback: string, msg?: ServerText | null) => serverText(fallback, msg, lang), [lang]);
}
