import type { TFunction } from "i18next";

import { localized, type IntakeQuestion } from "./questions";
import type { IntakeAnswer } from "./requestDraft";

/**
 * An answer in plain words for Review: the number, the option's name, the names joined, "Yes" or
 * "No", the text. Null for an optional question left empty (a switch always answers).
 */
export function answerText(
  t: TFunction,
  question: IntakeQuestion,
  answer: IntakeAnswer | undefined,
  locale: string,
): string | null {
  const optionName = (value: string) => {
    const option =
      "options" in question ? question.options.find((item) => item.value === value) : undefined;
    return option ? localized(option.labels, locale) : value;
  };
  switch (question.type) {
    case "boolean":
      return t(answer === true ? "request.review.yes" : "request.review.no");
    case "integer":
      return typeof answer === "number" ? new Intl.NumberFormat(locale).format(answer) : null;
    case "single_choice":
      return typeof answer === "string" ? optionName(answer) : null;
    case "multi_choice":
      return Array.isArray(answer) && answer.length > 0 ? answer.map(optionName).join(", ") : null;
    case "text":
      return typeof answer === "string" && answer.trim() !== "" ? answer.trim() : null;
  }
}
