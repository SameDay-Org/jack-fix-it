import type en from "@/i18n/locales/en.json";

/** The Help page's sections, in the order they are shown; each is named by `help.sections.<id>`. */
export const FAQ_SECTIONS = ["booking", "payments", "job", "account"] as const;
export type FaqSection = (typeof FAQ_SECTIONS)[number];

/** A question's id: its key under `help.faq` in the catalogs, so an id with no strings does not compile. */
export type FaqId = keyof (typeof en)["help"]["faq"];

export type FaqEntry = {
  id: FaqId;
  section: FaqSection;
  /** The i18n keys of the question and of its answer. */
  question: `help.faq.${FaqId}.question`;
  answer: `help.faq.${FaqId}.answer`;
};

const entry = (id: FaqId, section: FaqSection): FaqEntry => ({
  id,
  section,
  question: `help.faq.${id}.question`,
  answer: `help.faq.${id}.answer`,
});

/**
 * The FAQ, in reading order. A new question is one line here plus its `question` and `answer`
 * under `help.faq.<id>` in en.json and es.json (faq.test.ts fails on strings no entry shows).
 *
 * The answers state only what the product docs decide and the app does today. The cancellation and
 * refund rule (#3) and the problem window (#4) are still open, so `cancel` and `problem` say the
 * team decides case by case; no answer names a price, a fee or a number of hours. Contacts are
 * never exchanged: `chat` and `privacy` send people to the job's chat, which opens after booking.
 */
export const FAQ: readonly FaqEntry[] = [
  entry("request", "booking"),
  entry("quote", "booking"),
  entry("quoteExpiry", "booking"),
  entry("cancel", "booking"),
  entry("whenPay", "payments"),
  entry("payMethods", "payments"),
  entry("payFailed", "payments"),
  entry("proPaid", "payments"),
  entry("follow", "job"),
  entry("arrivalCode", "job"),
  entry("chat", "job"),
  entry("problem", "job"),
  entry("verified", "account"),
  entry("privacy", "account"),
  entry("verifyPhone", "account"),
  entry("language", "account"),
];

/** A section's questions, in reading order. */
export const faqIn = (section: FaqSection): FaqEntry[] =>
  FAQ.filter((item) => item.section === section);
