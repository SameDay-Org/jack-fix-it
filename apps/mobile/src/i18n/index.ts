import { getLocales } from "expo-localization";
import { createInstance } from "i18next";
import { initReactI18next } from "react-i18next";

import en from "./locales/en.json";
import es from "./locales/es.json";

const resources = {
  en: { translation: en },
  es: { translation: es },
};

/** A language the app is written in. */
export type Language = keyof typeof resources;

/** Every language of the app, in the order a picker lists them. */
export const LANGUAGES: readonly Language[] = ["en", "es"];

const fallbackLanguage: Language = "en";

/** `code` as a language of the app, or null when the app is not written in it. */
export function languageOf(code: string | null | undefined): Language | null {
  return code && Object.hasOwn(resources, code) ? (code as Language) : null;
}

/**
 * The device's language when we support it, English otherwise: what the app starts in and what a
 * signed-out app runs in. A signed-in account's saved language replaces it (`AccountLanguage`).
 */
export function deviceLanguage(): Language {
  return languageOf(getLocales()[0]?.languageCode) ?? fallbackLanguage;
}

// initReactI18next registers this instance for useTranslation(); no provider needed.
const i18n = createInstance();

void i18n.use(initReactI18next).init({
  resources,
  lng: deviceLanguage(),
  fallbackLng: fallbackLanguage,
  initAsync: false, // resources are bundled, so the first render already has them
  interpolation: { escapeValue: false }, // React already escapes output
});

/** The language on screen now. */
export function activeLanguage(): Language {
  return languageOf(i18n.resolvedLanguage) ?? fallbackLanguage;
}

/**
 * Puts the whole app in `language` at once: the catalogs are bundled, so the change is done when
 * this returns and every mounted `useTranslation()` renders again. Nothing happens when the app is
 * already in it.
 */
export function setLanguage(language: Language): void {
  if (activeLanguage() !== language) void i18n.changeLanguage(language);
}

export default i18n;
