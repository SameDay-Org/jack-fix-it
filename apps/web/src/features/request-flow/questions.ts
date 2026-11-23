import type { components } from "@jack/shared";

import type { Locale } from "@/i18n/config";

/** One of a category's intake questions (D8.3, #44; docs/intake-questions.md). */
export type IntakeQuestion = components["schemas"]["CategoryOut"]["intake_questions"][number];

/** An answer as the form holds it: a number, an option value, a list of them, yes/no or text. */
export type IntakeAnswer = number | string | boolean | readonly string[];

export type IntakeAnswers = Readonly<Record<string, IntakeAnswer>>;

/** Why an answer cannot go yet; each maps to one line under its question. */
export type QuestionError =
  | { kind: "required" }
  | { kind: "range"; min: number; max: number }
  | { kind: "tooFew"; count: number }
  | { kind: "tooMany"; count: number };

/** Labels are data per locale (en and es are always there): the page's language, else English. */
export function localized(texts: Readonly<Record<string, string>>, locale: Locale): string {
  return texts[locale] ?? texts.en ?? "";
}

type MultiChoiceQuestion = Extract<IntakeQuestion, { type: "multi_choice" }>;

/** The picks that are still among the question's options (never a value the API would refuse). */
export function offeredPicks(question: MultiChoiceQuestion, answer: IntakeAnswer | undefined) {
  const picked: readonly string[] = Array.isArray(answer) ? answer : [];
  return picked.filter((value) => question.options.some((option) => option.value === value));
}

const required = (question: IntakeQuestion): QuestionError | null =>
  question.required ? { kind: "required" } : null;

/**
 * What stops `answer` from going with the request, as the API judges it (categories/intake.py).
 * The same rules as the app (apps/mobile request/questions.ts), plus the most a multiple choice
 * takes: a checkbox list cannot stop at the limit the way the app's chips do. A yes/no always
 * has an answer (unticked is "no").
 */
export function questionError(
  question: IntakeQuestion,
  answer: IntakeAnswer | undefined,
): QuestionError | null {
  switch (question.type) {
    case "integer": {
      if (answer === undefined) return required(question);
      const { min, max } = question;
      const fits = typeof answer === "number" && Number.isInteger(answer);
      return fits && answer >= min && answer <= max ? null : { kind: "range", min, max };
    }
    case "single_choice":
      return question.options.some((option) => option.value === answer) ? null : required(question);
    case "multi_choice": {
      const count = offeredPicks(question, answer).length;
      const most = question.max_selected ?? question.options.length;
      if (count > most) return { kind: "tooMany", count: most };
      if (count === 0 && !question.required) return null;
      const least = Math.max(question.min_selected, 1);
      return count < least ? { kind: "tooFew", count: least } : null;
    }
    case "text":
      return typeof answer === "string" && answer.trim() !== "" ? null : required(question);
    case "boolean":
      return null;
  }
}

/** Every answer that cannot go yet, by question key, in the questions' order. */
export function questionErrors(
  questions: readonly IntakeQuestion[],
  answers: IntakeAnswers,
): Record<string, QuestionError> {
  const errors: Record<string, QuestionError> = {};
  for (const question of questions) {
    const error = questionError(question, answers[question.key]);
    if (error) errors[question.key] = error;
  }
  return errors;
}

/**
 * The answers as the request's `intake_answers`: by key, only the service's own questions, in
 * their order. A yes/no left alone is "no"; a blank text and an empty pick are left out (the
 * app's `intakeAnswersFor`).
 */
export function intakeAnswersFor(
  questions: readonly IntakeQuestion[],
  answers: IntakeAnswers,
): Record<string, number | string | boolean | string[]> {
  const body: Record<string, number | string | boolean | string[]> = {};
  for (const question of questions) {
    const answer = answers[question.key];
    if (question.type === "boolean") body[question.key] = answer === true;
    else if (question.type === "multi_choice") {
      const picks = offeredPicks(question, answer);
      if (picks.length > 0) body[question.key] = picks;
    } else if (typeof answer === "string") {
      const text = question.type === "text" ? answer.trim() : answer;
      if (text !== "") body[question.key] = text;
    } else if (typeof answer === "number") body[question.key] = answer;
  }
  return body;
}
