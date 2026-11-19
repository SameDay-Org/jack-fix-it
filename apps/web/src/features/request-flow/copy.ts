import type { TFunction } from "i18next";

import type { RequestFlowText } from "./types";

/**
 * The flow's words in the page's language (`request.*`), resolved on the server: the browser gets
 * these strings, not a catalog. A `{{name}}` in a template stays for the browser to fill
 * (fields.ts `fill`), as the disputes page does for its amount.
 */
export function requestFlowText(t: TFunction): RequestFlowText {
  return {
    progress: t("request.progress", { current: "{{current}}", total: "{{total}}" }),
    back: t("request.back"),
    next: t("request.next"),
    optional: t("request.optional", { label: "{{label}}" }),
    counter: t("request.counter", { length: "{{length}}", max: "{{max}}" }),
    check: t("request.check"),
    zip: {
      title: t("request.zip.title"),
      support: t("request.zip.support"),
      label: t("request.zip.label"),
      hint: t("request.zip.hint"),
      checking: t("request.zip.checking"),
      errors: {
        invalid: t("request.zip.errors.invalid"),
        rate_limited: t("request.zip.errors.rate_limited"),
        unavailable: t("request.zip.errors.unavailable"),
      },
    },
    waitlist: {
      title: t("request.waitlist.title"),
      body: t("request.waitlist.body", { zip: "{{zip}}" }),
      emailLabel: t("request.waitlist.emailLabel"),
      phoneLabel: t("request.waitlist.phoneLabel"),
      contactHint: t("request.waitlist.contactHint"),
      use: t("request.waitlist.use"),
      submit: t("request.waitlist.submit"),
      sending: t("request.waitlist.sending"),
      otherZip: t("request.waitlist.otherZip"),
      joinedTitle: t("request.waitlist.joinedTitle"),
      joinedBody: t("request.waitlist.joinedBody", { zip: "{{zip}}" }),
      home: t("request.waitlist.home"),
      servedNow: t("request.waitlist.servedNow", { zip: "{{zip}}" }),
      errors: {
        missing_contact: t("request.waitlist.errors.missing_contact"),
        invalid_email: t("request.waitlist.errors.invalid_email"),
        invalid_phone: t("request.waitlist.errors.invalid_phone"),
        invalid: t("request.waitlist.errors.invalid"),
        rate_limited: t("request.waitlist.errors.rate_limited"),
        unavailable: t("request.waitlist.errors.unavailable"),
      },
    },
    describe: {
      title: t("request.describe.title"),
      support: t("request.describe.support"),
      label: t("request.describe.label"),
      required: t("request.describe.required"),
      categoryLegend: t("request.describe.categoryLegend"),
      categoryHint: t("request.describe.categoryHint"),
      notSure: t("request.describe.notSure"),
    },
    questions: {
      support: t("request.questions.support"),
      required: t("request.questions.required"),
      range: t("request.questions.range", { min: "{{min}}", max: "{{max}}" }),
      // `count` as an option would pick a plural form before the number is known; both
      // languages say it the same way, so the keys have none and `replace` fills the name.
      tooFew: t("request.questions.tooFew", { replace: { count: "{{count}}" } }),
      tooMany: t("request.questions.tooMany", { replace: { count: "{{count}}" } }),
      pickUpTo: t("request.questions.pickUpTo", { replace: { count: "{{count}}" } }),
    },
  };
}
