import { defaultLocale, type Locale, locales } from "./config";

/** A supported locale from an account's `locale`, or the default one. */
export function toLocale(value: string | null | undefined): Locale {
  return locales.find((locale) => locale === value) ?? defaultLocale;
}
