import type { PostBody } from "@/api";
import type { Category } from "@/features/home/useCategories";

import type { IntakeAnswer } from "./requestDraft";

/** One of a category's intake questions (D8.3, #44; docs/intake-questions.md). */
export type IntakeQuestion = Category["intake_questions"][number];

/** Why an answer cannot go yet; each maps to one line under its question. */
export type QuestionError =
  | { kind: "required" }
  | { kind: "range"; min: number; max: number }
  | { kind: "tooFew"; count: number };

type IntakeAnswers = NonNullable<PostBody<"/v1/requests">["intake_answers"]>;

/** Labels are data per locale (en and es are always there): the app's language, else English. */
export function localized(texts: Readonly<Record<string, string>>, locale: string): string {
  return texts[locale] ?? texts.en ?? "";
}

type MultiChoiceQuestion = Extract<IntakeQuestion, { type: "multi_choice" }>;

/**
 * The picks that are still among the question's options. A pick the category no longer offers
 * (its questions were refetched after the server refused the answers) is neither shown, counted
 * nor sent.
 */
export function offeredPicks(question: MultiChoiceQuestion, answer: IntakeAnswer | undefined) {
  const picked: readonly string[] = Array.isArray(answer) ? answer : [];
  return picked.filter((value) => question.options.some((option) => option.value === value));
}

const required = (question: IntakeQuestion): QuestionError | null =>
  question.required ? { kind: "required" } : null;

/**
 * What stops `answer` from going with the request, as the API would judge it. A switch always has
 * an answer (off is "no"), and a text never runs past its limit (the field stops there).
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

/** The first question that cannot go yet, by key, and every error by key. */
export function questionErrors(
  questions: readonly IntakeQuestion[],
  answers: Readonly<Record<string, IntakeAnswer>>,
): Record<string, QuestionError> {
  const errors: Record<string, QuestionError> = {};
  for (const question of questions) {
    const error = questionError(question, answers[question.key]);
    if (error) errors[question.key] = error;
  }
  return errors;
}

/**
 * The answers as `RequestCreate.intake_answers`: by key, only the category's own questions, in
 * their order. A switch left alone is "no"; a blank text and an empty pick are left out.
 */
export function intakeAnswersFor(
  questions: readonly IntakeQuestion[],
  answers: Readonly<Record<string, IntakeAnswer>>,
): IntakeAnswers {
  const body: IntakeAnswers = {};
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
