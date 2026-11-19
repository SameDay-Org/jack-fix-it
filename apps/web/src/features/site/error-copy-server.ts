import type { TFunction } from "i18next";

import type { Locale } from "@/i18n/config";

import type { ErrorCopy } from "./error-copy";
import { LANDING_PATHS } from "./routes";

/** The panel's home, where a panel error screen leads (lib/session.ts PANEL_PATH). */
const PANEL_HOME = "/admin";

/** A public page's error words in one language, from the catalog (#462). */
export function siteErrorCopy(t: TFunction, locale: Locale): ErrorCopy {
  return {
    title: t("site.error.title"),
    body: t("site.error.body"),
    retry: t("site.error.retry"),
    home: t("site.error.home"),
    homeHref: LANDING_PATHS[locale],
  };
}

/** The panel's error words in the staff member's language (or the default one), from the catalog. */
export function panelErrorCopy(t: TFunction): ErrorCopy {
  return {
    title: t("admin.error.title"),
    body: t("admin.error.body"),
    retry: t("admin.error.retry"),
    home: t("admin.error.home"),
    homeHref: PANEL_HOME,
  };
}
