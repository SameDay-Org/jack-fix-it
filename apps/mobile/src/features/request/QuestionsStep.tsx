import { router } from "expo-router";
import { useRef, useState, type ComponentRef } from "react";
import { useTranslation } from "react-i18next";
import { AccessibilityInfo, ScrollView } from "react-native";

import { Button, Notice } from "@/components/ui";
import { categoryName, type Category } from "@/features/home/useCategories";

import { QuestionField } from "./QuestionField";
import { questionErrors } from "./questions";
import { setAnswer, useRequestDraft } from "./requestDraft";
import { StepScreen } from "./StepScreen";
import { nextStep, stepHref, type StepId } from "./steps";

// The space between two questions (the step's gap-6): kept above the first one with an error.
const QUESTION_GAP = 24;

type QuestionsStepProps = { category: Category; steps: readonly StepId[] };

/**
 * The category's intake questions, titled with the category the customer tapped on home. Errors
 * show after a Continue that found some (or when the server refused the answers) and then follow
 * each change; Continue scrolls to the first one and says so to screen readers.
 */
export function QuestionsStep({ category, steps }: QuestionsStepProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? "en";
  const questions = category.intake_questions;
  const answers = useRequestDraft((draft) => draft.answers);
  const refused = useRequestDraft((draft) => draft.refusal?.step === "questions");
  const [checked, setChecked] = useState(refused);
  const errors = checked ? questionErrors(questions, answers) : {};
  const scrollRef = useRef<ComponentRef<typeof ScrollView>>(null);
  const tops = useRef<Record<string, number>>({});
  // Sent back by the server (this screen stayed mounted under Review): show what to fix, and keep
  // showing it as the answers change.
  const [wasRefused, setWasRefused] = useState(refused);
  if (refused !== wasRefused) {
    setWasRefused(refused);
    if (refused) setChecked(true);
  }

  const onContinue = () => {
    const found = questionErrors(questions, answers);
    const first = questions.find((question) => found[question.key]);
    if (first) {
      setChecked(true);
      AccessibilityInfo.announceForAccessibility(t("request.questions.check"));
      const top = tops.current[first.key] ?? 0;
      scrollRef.current?.scrollTo({ y: Math.max(0, top - QUESTION_GAP), animated: true });
      return;
    }
    const next = nextStep("questions", steps);
    if (next) router.push(stepHref(next, steps));
  };

  return (
    <StepScreen
      step="questions"
      steps={steps}
      title={categoryName(category)}
      support={t("request.questions.support")}
      action={
        <Button
          label={t("common.continue")}
          size="lg"
          onPress={onContinue}
          testID="questions-continue"
        />
      }
      scrollRef={scrollRef}
      refusal={refused ? t("request.questions.refusedTitle") : undefined}
      testID="request-questions"
    >
      {refused ? (
        <Notice
          tone="danger"
          title={t("request.questions.refusedTitle")}
          body={t("request.questions.refusedBody")}
          testID="questions-refused"
        />
      ) : null}
      {questions.map((question) => (
        <QuestionField
          key={question.key}
          question={question}
          answer={answers[question.key]}
          error={errors[question.key]}
          locale={locale}
          onAnswer={(answer) => setAnswer(question.key, answer)}
          onLayout={({ nativeEvent }) => {
            tops.current[question.key] = nativeEvent.layout.y;
          }}
        />
      ))}
    </StepScreen>
  );
}
