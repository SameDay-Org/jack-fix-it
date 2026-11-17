"use client";

import { useEffect } from "react";

import type { Locale } from "@/i18n/config";

/**
 * Tells the document which language this page is in. The site has one root layout, whose
 * `<html lang>` is the default language for every route, so a page in another language says
 * so twice: its content sits in an element with its own `lang` (true in the server's HTML,
 * with or without scripts), and this sets `<html lang>` once the page runs, putting the
 * previous value back when the page is left.
 */
export function HtmlLang({ locale }: { locale: Locale }) {
  useEffect(() => {
    const root = document.documentElement;
    const previous = root.lang;
    root.lang = locale;
    return () => {
      root.lang = previous;
    };
  }, [locale]);
  return null;
}
