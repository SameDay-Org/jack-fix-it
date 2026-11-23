import type { Locale } from "@/i18n/config";

import { type IntakeAnswer, type IntakeQuestion, localized, offeredPicks } from "./questions";

// How the review step shows what the visitor gave: plain text only.

/** `+19545550100` as `(954) 555-0100`; anything else as it is. */
export function formatPhone(e164: string): string {
  const national = e164.replace(/[^0-9]/g, "").slice(-10);
  return national.length === 10
    ? `(${national.slice(0, 3)}) ${national.slice(3, 6)}-${national.slice(6)}`
    : e164;
}

/** A day (YYYY-MM-DD) in words, in the page's language: midnight UTC, so no zone moves it. */
export function formatDay(day: string, locale: Locale): string {
  return new Intl.DateTimeFormat(locale, {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${day}T00:00:00Z`));
}

/** An answer in words: an option's label, a list of them, yes or no, a number or the text. */
export function answerText(
  question: IntakeQuestion,
  answer: IntakeAnswer | undefined,
  locale: Locale,
  words: { yes: string; no: string },
): string | null {
  switch (question.type) {
    case "boolean":
      return answer === true ? words.yes : words.no;
    case "single_choice": {
      const option = question.options.find((item) => item.value === answer);
      return option ? localized(option.labels, locale) : null;
    }
    case "multi_choice": {
      const picks = offeredPicks(question, answer);
      if (picks.length === 0) return null;
      return question.options
        .filter((option) => picks.includes(option.value))
        .map((option) => localized(option.labels, locale))
        .join(", ");
    }
    case "integer":
      return typeof answer === "number" ? String(answer) : null;
    case "text":
      return typeof answer === "string" && answer.trim() !== "" ? answer.trim() : null;
  }
}
