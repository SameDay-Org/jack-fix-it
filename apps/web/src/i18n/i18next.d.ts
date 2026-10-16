import "i18next";

import type en from "./locales/en.json";

// Type-checks every t("...") key against the English catalog.
declare module "i18next" {
  interface CustomTypeOptions {
    resources: { translation: typeof en };
  }
}
