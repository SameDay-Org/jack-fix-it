export const locales = ["en", "es"] as const;

export type Locale = (typeof locales)[number];

/** English is the primary language; Spanish ships at launch. */
export const defaultLocale: Locale = "en";
