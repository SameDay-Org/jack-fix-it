import { useQueryClient } from "@tanstack/react-query";
import { router, usePreventRemove } from "expo-router";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Image, Text, View } from "react-native";

import { Button, Notice } from "@/components/ui";
import { ControlIcon } from "@/components/icons";
import { SAVED_ADDRESSES_QUERY_KEY, useSavedAddresses } from "@/features/addresses";
import { CATEGORIES_QUERY_KEY, categoryName, type Category } from "@/features/home/useCategories";
import type { MediaItem } from "@/features/media";
import { tokens } from "@/theme";

import {
  addressErrors,
  addressLine,
  resolveAddress,
  savedAddressBody,
  typedAddressBody,
} from "./address";
import { answerText } from "./answerText";
import { formatLongDay, isPastDay } from "./dates";
import { refuseStep, useRequestDraft, type RequestDraft, type StepRefusal } from "./requestDraft";
import { useRequestFlowContext } from "./RequestFlowLayout";
import { requestBody } from "./send";
import { StepScreen } from "./StepScreen";
import { stepHref, type StepId } from "./steps";

type ReviewFailure = "failed" | "rateLimited" | "rejected";

const ADDRESS_REFUSED: StepRefusal = { step: "where", reason: "invalidAddress" };
const DATE_STALE: StepRefusal = { step: "when", reason: "staleDate" };

type ReviewStepProps = { category: Category; steps: readonly StepId[] };

/**
 * Everything the request says, in plain words, before it goes: the answers, the description and its
 * files, the address and the day, each with an Edit link back to its step. Send shows its progress
 * and takes one press; what the server refuses sends the customer to the step that can fix it, and
 * anything else stays here with "Try again".
 */
export function ReviewStep({ category, steps }: ReviewStepProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? "en";
  const queryClient = useQueryClient();
  const { media, finish, send, sending } = useRequestFlowContext();
  const draft = useRequestDraft((value) => value);
  const saved = useSavedAddresses();
  const [failure, setFailure] = useState<ReviewFailure | null>(null);
  // Android's back and the iOS swipe wait for the send's answer too (the flow's guard only covers
  // leaving the flow, not this step).
  usePreventRemove(sending, () => {});
  const resolved = resolveAddress(draft.address, saved.data?.items);
  const address =
    resolved.kind === "saved"
      ? savedAddressBody(resolved.address)
      : typedAddressBody(draft.typedAddress);

  const backTo = (refusal: StepRefusal) => {
    refuseStep(refusal);
    router.dismissTo(stepHref(refusal.step, steps));
  };

  // The notice announces itself: onSend clears the failure first, so each one mounts it anew.
  const fail = (reason: ReviewFailure) => setFailure(reason);

  const dateStale = () => draft.preferredDate !== null && isPastDay(draft.preferredDate);

  const onSend = () => {
    // A day chosen before midnight has passed meanwhile: the API would refuse it.
    if (dateStale()) return backTo(DATE_STALE);
    setFailure(null);
    void send(requestBody({ draft, category, address, mediaKeys: media.keys }), {
      onSent: finish,
      onFailed: (outcome) => {
        if (outcome.kind === "signedOut") return; // the session's own screens take over
        if (outcome.kind === "retry") return fail(outcome.reason);
        if (outcome.kind === "rejected") {
          // The API's validation_error names no field. When the typed address fails the form's
          // own check, Where marks what to fix: sending the same body again would fail the same way.
          const typedInvalid =
            resolved.kind === "typed" && Object.keys(addressErrors(draft.typedAddress)).length > 0;
          if (typedInvalid) return backTo(ADDRESS_REFUSED);
          // Midnight passed while the request was on its way.
          return dateStale() ? backTo(DATE_STALE) : fail("rejected");
        }
        // What the server knows better: which ZIPs are served, the category's questions (also
        // when a category that asked none now does: its steps change with the refetch).
        if (outcome.refusal.reason === "zipNotServed") {
          void queryClient.invalidateQueries({ queryKey: SAVED_ADDRESSES_QUERY_KEY });
        }
        if (outcome.refusal.reason === "invalidAnswers") {
          void queryClient.invalidateQueries({ queryKey: CATEGORIES_QUERY_KEY });
        }
        if (!steps.includes(outcome.refusal.step)) return fail("rejected");
        backTo(outcome.refusal);
      },
    });
  };

  return (
    <StepScreen
      step="review"
      steps={steps}
      title={t("request.review.title")}
      support={t("request.review.support")}
      action={
        <View className="gap-3">
          {failure ? (
            <Notice
              tone="danger"
              title={t(`request.review.${failure}Title`)}
              body={t(`request.review.${failure}Body`)}
              testID="review-failed"
            />
          ) : null}
          <Button
            label={t(failure ? "request.review.retry" : "request.review.send")}
            size="lg"
            loading={sending}
            onPress={onSend}
            testID="review-send"
          />
        </View>
      }
      testID="request-review"
    >
      {steps.includes("questions") ? (
        <ReviewSection
          locked={sending}
          title={categoryName(category)}
          editLabel={t("request.review.editAnswers")}
          onEdit={() => router.dismissTo(stepHref("questions", steps))}
          testID="review-answers"
        >
          <AnswerList category={category} draft={draft} locale={locale} />
        </ReviewSection>
      ) : null}
      <ReviewSection
        locked={sending}
        title={t("request.review.description")}
        editLabel={t("request.review.editDescription")}
        onEdit={() => router.dismissTo(stepHref("describe", steps))}
        testID="review-description"
      >
        <Text className="text-body text-navy-900">{draft.description.trim()}</Text>
        {media.items.length > 0 ? <Thumbnails items={media.items} /> : null}
      </ReviewSection>
      <ReviewSection
        locked={sending}
        title={t("request.review.address")}
        editLabel={t("request.review.editAddress")}
        onEdit={() => router.dismissTo(stepHref("where", steps))}
        testID="review-address"
      >
        {resolved.kind === "saved" ? (
          <Text className="text-headline text-navy-900">{resolved.address.label}</Text>
        ) : null}
        <Text className="text-body text-navy-900">{addressLine(address)}</Text>
      </ReviewSection>
      <ReviewSection
        locked={sending}
        title={t("request.review.when")}
        editLabel={t("request.review.editWhen")}
        onEdit={() => router.dismissTo(stepHref("when", steps))}
        testID="review-when"
      >
        <Text className="text-body text-navy-900">
          {draft.preferredDate === null
            ? t("request.review.flexible")
            : formatLongDay(draft.preferredDate, locale)}
        </Text>
      </ReviewSection>
    </StepScreen>
  );
}

type ReviewSectionProps = {
  title: string;
  /** "Edit address": the link's spoken name; it shows as "Edit". */
  editLabel: string;
  onEdit: () => void;
  /** A send is in flight: the request cannot change under it. */
  locked: boolean;
  children: ReactNode;
  testID: string;
};

/** A part of the request: its name and Edit on one line, the content under, a rule above. */
function ReviewSection({ title, editLabel, onEdit, locked, children, testID }: ReviewSectionProps) {
  const { t } = useTranslation();
  return (
    <View className="gap-2 border-t border-navy-900/10 pt-4" testID={testID}>
      <View className="flex-row items-center justify-between gap-3">
        <Text
          accessibilityRole="header"
          className="flex-1 text-footnote font-semibold text-gray-500"
        >
          {title}
        </Text>
        <Button
          label={t("request.review.edit")}
          accessibilityLabel={editLabel}
          variant="ghost"
          disabled={locked}
          onPress={onEdit}
          className="-mr-5"
          testID={`${testID}-edit`}
        />
      </View>
      {children}
    </View>
  );
}

type AnswerListProps = { category: Category; draft: RequestDraft; locale: string };

/** Each answered question as "label: answer"; an optional one left empty is not listed. */
function AnswerList({ category, draft, locale }: AnswerListProps) {
  const { t } = useTranslation();
  const rows = category.intake_questions.flatMap((question) => {
    const text = answerText(t, question, draft.answers[question.key], locale);
    return text === null ? [] : [{ key: question.key, label: question.labels, text }];
  });
  return (
    <View className="gap-3">
      {rows.map((row) => (
        <View key={row.key} className="gap-0.5" testID={`review-answer-${row.key}`}>
          <Text className="text-callout text-gray-500">{row.label[locale] ?? row.label.en}</Text>
          <Text className="text-body text-navy-900">{row.text}</Text>
        </View>
      ))}
    </View>
  );
}

/** The attached files as small squares: the photo itself, or a navy tile with a play mark. */
function Thumbnails({ items }: { items: readonly MediaItem[] }) {
  const { t } = useTranslation();
  return (
    <View
      accessible
      accessibilityLabel={t("request.review.mediaCount", { count: items.length })}
      className="flex-row flex-wrap gap-2 pt-1"
      testID="review-media"
    >
      {items.map((item) =>
        item.kind === "image" ? (
          <Image
            key={item.id}
            source={{ uri: item.previewUri }}
            className="h-16 w-16 rounded-md bg-gray-500/15"
          />
        ) : (
          <View
            key={item.id}
            className="h-16 w-16 items-center justify-center rounded-md bg-navy-900"
          >
            <ControlIcon name="play" color={tokens.colors.white} filled />
          </View>
        ),
      )}
    </View>
  );
}
