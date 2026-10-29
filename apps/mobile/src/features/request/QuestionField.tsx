import type { TFunction } from "i18next";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Switch, Text, View, type LayoutChangeEvent } from "react-native";

import { Chip, ChoiceCard, Input, Stepper } from "@/components/ui";
import { tokens } from "@/theme";

import { lengthCounter } from "./counter";
import { localized, offeredPicks, type IntakeQuestion, type QuestionError } from "./questions";
import type { IntakeAnswer } from "./requestDraft";

// Ranges up to this wide take a stepper; wider ones (a home's square feet) a number field.
const STEPPER_MAX_SPAN = 20;

type OnAnswer = (answer: IntakeAnswer | undefined) => void;

export type QuestionFieldProps = {
  question: IntakeQuestion;
  answer: IntakeAnswer | undefined;
  error: QuestionError | undefined;
  /** The app's language: labels are data per locale. */
  locale: string;
  onAnswer: OnAnswer;
  onLayout?: (event: LayoutChangeEvent) => void;
};

/** One intake question, rendered by its type, with its label, its help and its error. */
export function QuestionField({
  question,
  answer,
  error,
  locale,
  onAnswer,
  onLayout,
}: QuestionFieldProps) {
  const { t } = useTranslation();
  const label = localized(question.labels, locale);
  const help = question.help ? localized(question.help, locale) : undefined;
  const message = error ? errorMessage(t, error) : undefined;
  const testID = `question-${question.key}`;

  if (question.type === "text") {
    const text = typeof answer === "string" ? answer : "";
    return (
      <View onLayout={onLayout}>
        <Input
          label={question.required ? label : t("request.optionalLabel", { label })}
          value={text}
          onChangeText={(next) => onAnswer(next === "" ? undefined : next)}
          hint={help}
          error={message}
          multiline
          maxLength={question.max_length}
          counter={lengthCounter(t, text.length, question.max_length)}
          testID={testID}
        />
      </View>
    );
  }

  if (question.type === "integer" && question.max - question.min > STEPPER_MAX_SPAN) {
    return (
      <View onLayout={onLayout}>
        <NumberField
          label={question.required ? label : t("request.optionalLabel", { label })}
          hint={help}
          error={message}
          value={typeof answer === "number" ? answer : null}
          max={question.max}
          onAnswer={onAnswer}
          testID={`${testID}-number`}
        />
      </View>
    );
  }

  if (question.type === "boolean") {
    return (
      <View onLayout={onLayout} className="gap-1" testID={testID}>
        <View className="min-h-12 flex-row items-center gap-4">
          <Text className="flex-1 text-headline text-navy-900">{label}</Text>
          <Switch
            accessibilityLabel={label}
            accessibilityHint={help}
            value={answer === true}
            onValueChange={onAnswer}
            trackColor={{ false: tokens.colors["gray-500"], true: tokens.colors["green-700"] }}
            thumbColor={tokens.colors.white}
            ios_backgroundColor={tokens.colors["gray-500"]}
            testID={`${testID}-switch`}
          />
        </View>
        {help ? <Text className="text-callout text-gray-500">{help}</Text> : null}
      </View>
    );
  }

  return (
    <QuestionBlock
      label={label}
      optional={!question.required}
      help={help}
      error={message}
      onLayout={onLayout}
      testID={testID}
    >
      <ChoiceControl
        question={question}
        answer={answer}
        label={label}
        invalid={Boolean(error)}
        locale={locale}
        onAnswer={onAnswer}
      />
    </QuestionBlock>
  );
}

type ChoiceControlProps = {
  question: Extract<IntakeQuestion, { type: "integer" | "single_choice" | "multi_choice" }>;
  answer: IntakeAnswer | undefined;
  label: string;
  invalid: boolean;
  locale: string;
  onAnswer: OnAnswer;
};

/** The control for a small number or a choice: a stepper, choice cards, or chips. */
function ChoiceControl({ question, answer, label, invalid, locale, onAnswer }: ChoiceControlProps) {
  const { t } = useTranslation();
  const testID = `question-${question.key}`;

  if (question.type === "integer") {
    return (
      <Stepper
        label={label}
        value={typeof answer === "number" ? answer : null}
        min={question.min}
        max={question.max}
        onChange={onAnswer}
        invalid={invalid}
        testID={`${testID}-stepper`}
      />
    );
  }

  if (question.type === "single_choice") {
    return (
      <View accessibilityRole="radiogroup" accessibilityLabel={label} className="gap-3">
        {question.options.map((option) => (
          <ChoiceCard
            key={option.value}
            title={localized(option.labels, locale)}
            description={option.description ? localized(option.description, locale) : undefined}
            selected={answer === option.value}
            onPress={() => onAnswer(option.value)}
            testID={`${testID}-${option.value}`}
          />
        ))}
      </View>
    );
  }

  const picked = offeredPicks(question, answer);
  const most = question.max_selected ?? question.options.length;
  const full = picked.length >= most;
  const toggle = (value: string) => {
    const next = picked.includes(value)
      ? picked.filter((item) => item !== value)
      : [...picked, value];
    onAnswer(next.length > 0 ? next : undefined);
  };

  return (
    <View className="gap-2">
      {most < question.options.length ? (
        <Text className="text-footnote text-gray-500">
          {t("request.questions.pickUpTo", { count: most })}
        </Text>
      ) : null}
      <View accessibilityLabel={label} className="flex-row flex-wrap gap-2">
        {question.options.map((option) => {
          const selected = picked.includes(option.value);
          return (
            <Chip
              key={option.value}
              label={localized(option.labels, locale)}
              hint={option.description ? localized(option.description, locale) : undefined}
              selected={selected}
              disabled={full && !selected}
              onPress={() => toggle(option.value)}
              testID={`${testID}-${option.value}`}
            />
          );
        })}
      </View>
    </View>
  );
}

type NumberFieldProps = {
  label: string;
  hint?: string;
  error?: string;
  value: number | null;
  max: number;
  onAnswer: OnAnswer;
  testID: string;
};

/** A whole number typed in: digits only, no longer than the largest allowed value. */
function NumberField({ label, hint, error, value, max, onAnswer, testID }: NumberFieldProps) {
  const [text, setText] = useState(value === null ? "" : String(value));
  return (
    <Input
      label={label}
      hint={hint}
      error={error}
      value={text}
      onChangeText={(next) => {
        const digits = next.replace(/[^0-9]/g, "");
        setText(digits);
        onAnswer(digits === "" ? undefined : Number(digits));
      }}
      keyboardType="number-pad"
      maxLength={String(max).length}
      testID={testID}
    />
  );
}

type QuestionBlockProps = {
  label: string;
  optional: boolean;
  help?: string;
  error?: string;
  children: ReactNode;
  onLayout?: (event: LayoutChangeEvent) => void;
  testID: string;
};

/** A question's label (with "Optional"), its help, its control and the error under it. */
function QuestionBlock({
  label,
  optional,
  help,
  error,
  children,
  onLayout,
  testID,
}: QuestionBlockProps) {
  const { t } = useTranslation();
  return (
    <View onLayout={onLayout} className="gap-3" testID={testID}>
      <View className="gap-1">
        <Text className="text-headline text-navy-900">
          {optional ? t("request.optionalLabel", { label }) : label}
        </Text>
        {help ? <Text className="text-callout text-gray-500">{help}</Text> : null}
      </View>
      {children}
      {error ? (
        <Text
          accessibilityLiveRegion="polite"
          className="text-footnote text-danger"
          testID={`${testID}-error`}
        >
          {error}
        </Text>
      ) : null}
    </View>
  );
}

function errorMessage(t: TFunction, error: QuestionError): string {
  switch (error.kind) {
    case "required":
      return t("request.questions.required");
    case "range":
      return t("request.questions.range", { min: error.min, max: error.max });
    case "tooFew":
      return t("request.questions.tooFew", { count: error.count });
  }
}
