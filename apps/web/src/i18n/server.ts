import { createInstance, type TFunction } from "i18next";

import { defaultLocale, type Locale } from "./config";
import en from "./locales/en.json";
import es from "./locales/es.json";

const resources = {
  en: { translation: en },
  es: { translation: es },
};

/**
 * Translator for server components. Each call gets its own i18next instance, so concurrent
 * requests in different languages never share state.
 */
export async function getT(locale: Locale): Promise<TFunction> {
  const i18n = createInstance();
  return i18n.init({
    lng: locale,
    fallbackLng: defaultLocale,
    resources,
    interpolation: { escapeValue: false }, // React already escapes output
  });
}
