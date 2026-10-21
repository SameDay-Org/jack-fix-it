import type { PostBody } from "@/api";
import i18n from "@/i18n";

type AccountLocale = PostBody<"/v1/auth/register">["locale"];

/** The catalog the app runs in (the device language when supported): what a new account is created with. */
export function deviceLocale(): AccountLocale {
  return i18n.resolvedLanguage === "es" ? "es" : "en";
}
