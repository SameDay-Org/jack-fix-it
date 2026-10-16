import { getLocales } from "expo-localization";
import { createInstance } from "i18next";
import { initReactI18next } from "react-i18next";

import en from "./locales/en.json";
import es from "./locales/es.json";

const resources = {
  en: { translation: en },
  es: { translation: es },
};

type Language = keyof typeof resources;

const fallbackLanguage: Language = "en";

/** Device language when we support it, English otherwise. A saved user choice comes later (D5.5). */
function deviceLanguage(): Language {
  const code = getLocales()[0]?.languageCode;
  return code && Object.hasOwn(resources, code) ? (code as Language) : fallbackLanguage;
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

export default i18n;
