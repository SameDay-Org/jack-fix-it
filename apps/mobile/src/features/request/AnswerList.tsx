import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";

import { answerText } from "./answerText";
import { localized, type IntakeQuestion } from "./questions";
import type { IntakeAnswer } from "./requestDraft";

/**
 * An answer as the app keeps it, from a value the API sent (`intake_answers`, any JSON): a
 * number, a string, a yes/no or a list of strings. Anything else is no answer.
 */
export function asIntakeAnswer(value: unknown): IntakeAnswer | undefined {
  if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value as string[];
  }
  return undefined;
}

/** The answered questions, in the category's order, as label and plain words. */
export function answerRows(
  t: ReturnType<typeof useTranslation>["t"],
  questions: readonly IntakeQuestion[],
  answers: Readonly<Record<string, unknown>>,
  locale: string,
): { key: string; label: string; text: string }[] {
  return questions.flatMap((question) => {
    const text = answerText(t, question, asIntakeAnswer(answers[question.key]), locale);
    return text === null
      ? []
      : [{ key: question.key, label: localized(question.labels, locale), text }];
  });
}

type AnswerListProps = {
  questions: readonly IntakeQuestion[];
  answers: Readonly<Record<string, unknown>>;
  locale: string;
  /** Each row's testID is `<prefix>-<question key>`. */
  testIDPrefix: string;
};

/**
 * The category's questions with their answers, each as its label over the answer in plain words
 * ("label: answer"): the customer's Review step and the pro's opportunity show them alike. An
 * optional question left empty is not listed.
 */
export function AnswerList({ questions, answers, locale, testIDPrefix }: AnswerListProps) {
  const { t } = useTranslation();
  const rows = answerRows(t, questions, answers, locale);
  return (
    <View className="gap-3">
      {rows.map((row) => (
        <View key={row.key} className="gap-0.5" testID={`${testIDPrefix}-${row.key}`}>
          <Text className="text-callout text-gray-500">{row.label}</Text>
          <Text className="text-body text-navy-900">{row.text}</Text>
        </View>
      ))}
    </View>
  );
}
