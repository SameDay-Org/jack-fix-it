import type { components } from "@jack/shared";

/** One of a category's intake questions, as `GET /v1/categories` gives it. */
export type IntakeQuestion = components["schemas"]["CategoryOut"]["intake_questions"][number];

/** One answer on the card: the question in the reader's words and what the customer said. */
export type AnswerRow = { key: string; question: string; answer: string };

/** The words for a yes/no answer. */
export type YesNo = { yes: string; no: string };

/** A text the API gives per language: the reader's, else English, else the fallback. */
function localized(texts: Record<string, string> | undefined, locale: string, fallback: string) {
  return texts?.[locale]?.trim() || texts?.en?.trim() || fallback;
}

/** An answer as it is stored: what the customer picked or typed. */
export function storedText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(storedText).join(", ");
  return JSON.stringify(value);
}

function optionLabel(
  question: Extract<IntakeQuestion, { options: unknown }>,
  value: unknown,
  locale: string,
): string {
  const option = question.options.find((candidate) => candidate.value === value);
  return option ? localized(option.labels, locale, option.value) : storedText(value);
}

function answerText(question: IntakeQuestion, value: unknown, locale: string, words: YesNo) {
  switch (question.type) {
    case "single_choice":
      return optionLabel(question, value, locale);
    case "multi_choice":
      return Array.isArray(value)
        ? value.map((pick) => optionLabel(question, pick, locale)).join(", ")
        : storedText(value);
    case "boolean":
      if (value === true) return words.yes;
      if (value === false) return words.no;
      return storedText(value);
    default:
      return storedText(value);
  }
}

/**
 * A request's intake answers in the category's own words (#546): each question's label and,
 * for a choice, each option's label, in the reader's language (else English). What the
 * category no longer has (a retired category, a key or an option removed since) stays as it
 * is stored, so nothing the customer said is ever hidden.
 */
export function intakeAnswerRows(
  answers: Record<string, unknown>,
  questions: readonly IntakeQuestion[],
  locale: string,
  words: YesNo,
): AnswerRow[] {
  return Object.entries(answers).map(([key, value]) => {
    const question = questions.find((candidate) => candidate.key === key);
    if (!question) return { key, question: key, answer: storedText(value) };
    return {
      key,
      question: localized(question.labels, locale, key),
      answer: answerText(question, value, locale, words),
    };
  });
}
