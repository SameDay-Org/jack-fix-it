import { router, useLocalSearchParams, type Href } from "expo-router";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { KeyboardAvoidingView, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useSession } from "@/api";
import {
  announce,
  Button,
  Card,
  Input,
  Notice,
  Screen,
  Skeleton,
  StarRating,
  StarsShown,
  TextSkeleton,
  type StarScore,
} from "@/components/ui";
import { backToPrevious, BackButton } from "@/features/auth/components/BackButton";
import { jobHref } from "@/features/jobs/api";
import { isUuid } from "@/features/quotes/navigation";
import { useSettledError } from "@/features/quotes/useRequestQuotes";
import { lengthCounter } from "@/features/request/counter";

import { COMMENT_MAX, DIMENSIONS, reviewFailureOf, useMyReview, type ReviewSide } from "./api";
import { rate, writeComment } from "./draft";
import { useRateForm, type RateForm } from "./useRateForm";

/** The stars of the thanks: as large as the ones that were tapped. */
const THANKS_STARS = 40;
/** The skeleton's shapes: the big star row's height, and a details card of two to four rows. */
const STAR_ROW = 56;
const DETAILS_HEIGHT = 176;

/**
 * "Rate your pro" / "Rate your customer" (`/jobs/[id]/rate`, #77), for the job's customer or its
 * pro (the session's role decides which: the API refuses anyone else). One full screen: the
 * overall stars (required), the side's optional dimensions, an optional comment, Send. The job's
 * "mine" decides what shows: the form while a review can be written, the thanks once one was, a
 * calm "not yet" while the job is not confirmed. Nothing of the other side's review is read.
 */
export function RateScreen() {
  const { id, request } = useLocalSearchParams<{ id: string; request?: string }>();
  const { user } = useSession();
  const side: ReviewSide = user?.role === "pro" ? "pro" : "customer";
  const valid = isUuid(id);
  const mine = useMyReview(id, valid);
  const shownError = useSettledError(mine.data, mine.error);
  const form = useRateForm(id, side);
  // Back with no history: the customer's job (their links name the request), the pro's job.
  const fallback: Href = isUuid(request)
    ? jobHref(request)
    : side === "pro" && valid
      ? { pathname: "/jobs/[id]", params: { id } }
      : "/";

  const rated = form.sent?.overall ?? mine.data?.rated ?? null;
  let content;
  if (!valid || form.failure === "gone" || reviewFailureOf(shownError) === "gone") {
    content = <GoneState fallback={fallback} />;
  } else if (rated !== null) {
    content = (
      <Thanks
        rated={rated}
        fresh={form.sent !== null}
        redacted={form.sent?.redacted ?? false}
        fallback={fallback}
      />
    );
  } else if (form.alreadyReviewed) {
    // Rated already (the server's 409), its stars not read yet: never the form again.
    content = (
      <RatedUnavailable
        fallback={fallback}
        retry={() => void mine.refetch()}
        busy={mine.isFetching}
        fresh={form.failure === "alreadyReviewed"}
      />
    );
  } else if (mine.data === undefined) {
    content = shownError ? (
      <LoadFailed fallback={fallback} retry={() => void mine.refetch()} busy={mine.isFetching} />
    ) : (
      <RateSkeleton fallback={fallback} />
    );
  } else if (!mine.data.canReview || form.failure === "notReviewable") {
    content = <NotYet fallback={fallback} />;
  } else {
    content = <RateFormView jobId={id} side={side} form={form} fallback={fallback} />;
  }

  return (
    <Screen bar="light" testID="rate-screen">
      {content}
    </Screen>
  );
}

type RateFormViewProps = { jobId: string; side: ReviewSide; form: RateForm; fallback: Href };

function RateFormView({ jobId, side, form, fallback }: RateFormViewProps) {
  const { t } = useTranslation();
  const { top } = useSafeAreaInsets();
  const { ratings, comment, body, busy, failure, submit } = form;
  const over = Math.max(0, comment.length - COMMENT_MAX);
  const retry = failure === "offline" || failure === "failed";

  return (
    <KeyboardAvoidingView
      // Padding on both platforms (the app draws edge to edge on Android); the offset adds back the
      // status bar `Screen` starts the content below.
      behavior="padding"
      keyboardVerticalOffset={top}
      className="flex-1"
    >
      <ScrollView
        contentContainerClassName="flex-grow gap-8 px-4 pb-6 pt-2"
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        testID="rate-form"
      >
        <View className="gap-2">
          <BackButton fallbackHref={fallback} />
          <Text accessibilityRole="header" className="text-title-1 text-navy-900">
            {t(`reviews.title.${side}`)}
          </Text>
          <Text className="text-body text-gray-500">{t(`reviews.intro.${side}`)}</Text>
        </View>

        <View className="items-center gap-2">
          <StarRating
            label={t("reviews.overall.label")}
            value={ratings.overall ?? null}
            onChange={(score) => rate(jobId, "overall", score)}
            size="lg"
            disabled={busy}
            testID="rate-overall"
          />
          <Text
            className="self-stretch text-center text-headline text-navy-900"
            testID="rate-overall-word"
          >
            {ratings.overall ? t(`reviews.word.${ratings.overall}`) : t("reviews.overall.prompt")}
          </Text>
        </View>

        <View className="gap-3">
          <View className="gap-1">
            <Text accessibilityRole="header" className="text-headline text-navy-900">
              {t("reviews.details.title")}
            </Text>
            <Text className="text-footnote text-gray-500">{t("reviews.details.optional")}</Text>
          </View>
          <Card className="gap-4" testID="rate-details">
            {DIMENSIONS[side].map((dimension, index) => (
              <View key={dimension} className="gap-1">
                {index > 0 ? <View className="mb-3 h-px bg-navy-900/10" /> : null}
                <DimensionTitle
                  name={t(`reviews.dimension.${dimension}`)}
                  score={ratings[dimension]}
                />
                <StarRating
                  label={t(`reviews.dimension.${dimension}`)}
                  value={ratings[dimension] ?? null}
                  onChange={(score) => rate(jobId, dimension, score)}
                  clearable
                  disabled={busy}
                  testID={`rate-${dimension}`}
                />
              </View>
            ))}
          </Card>
        </View>

        {/* No native length limit: a long paste is never cut behind the person's back. Past the
            limit the field says by how much, and Send waits. */}
        <Input
          label={t("common.optionalLabel", { label: t("reviews.comment.label") })}
          value={comment}
          onChangeText={(text) => writeComment(jobId, text)}
          hint={t("reviews.comment.hint")}
          error={over > 0 ? t("reviews.comment.tooLong", { count: over }) : undefined}
          multiline
          counter={lengthCounter(t, comment.length, COMMENT_MAX)}
          autoCapitalize="sentences"
          disabled={busy}
          testID="rate-comment"
        />

        {failure && failure !== "gone" && failure !== "notReviewable" ? (
          <Notice
            tone="info"
            title={t(`reviews.failure.${failure}.title`)}
            body={t(`reviews.failure.${failure}.body`)}
            testID="rate-failure"
          />
        ) : null}

        <Button
          label={retry ? t("reviews.retry") : t("reviews.send")}
          size="lg"
          disabled={!body}
          loading={busy}
          onPress={submit}
          className="mt-auto"
          testID="rate-send"
        />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

/** A dimension's name, and the word for the stars given to it once there are some. */
function DimensionTitle({ name, score }: { name: string; score: StarScore | undefined }) {
  const { t } = useTranslation();
  return (
    // The row below says both to a screen reader. The name grows into the row's free width: sized
    // to its own text, a long one wraps by a sub-pixel at 160 dpi and loses its last word. It never
    // shrinks for the word: with large text the word goes under the name instead of cutting it.
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className="flex-row flex-wrap items-baseline gap-x-3"
    >
      <Text className="shrink-0 grow text-callout font-semibold text-navy-900">{name}</Text>
      {score ? (
        <Text className="text-footnote text-gray-500">{t(`reviews.word.${score}`)}</Text>
      ) : null}
    </View>
  );
}

type ThanksProps = {
  rated: number;
  /** The review went on this visit (or while the screen was closed), not on an earlier one. */
  fresh: boolean;
  redacted: boolean;
  fallback: Href;
};

/** The review went (now, or before): its stars, calmly, and the way back. */
function Thanks({ rated, fresh, redacted, fallback }: ThanksProps) {
  const { t } = useTranslation();
  const title = t("reviews.thanks.title");
  const body = t("reviews.thanks.body", { count: rated });
  // Said once when the thanks replaces the form (the redaction notice speaks for itself); opened
  // on a job reviewed before, the screen reads like any other.
  const said = useRef(false);
  useEffect(() => {
    if (!fresh || said.current) return;
    said.current = true;
    announce(`${title}. ${body}`);
  }, [body, fresh, title]);

  return (
    <ScrollView contentContainerClassName="flex-grow gap-8 px-4 pb-6 pt-2" testID="rate-thanks">
      <BackButton fallbackHref={fallback} />
      <View className="flex-1 items-center justify-center gap-6">
        <StarsShown value={rated} glyph={THANKS_STARS} />
        <View className="items-center gap-2 self-stretch">
          <Text
            accessibilityRole="header"
            className="self-stretch text-center text-title-1 text-navy-900"
          >
            {title}
          </Text>
          <Text
            className="self-stretch text-center text-body text-gray-500"
            testID="rate-thanks-body"
          >
            {body}
          </Text>
        </View>
        {redacted ? (
          <Notice
            tone="info"
            title={t("reviews.redacted.title")}
            body={t("reviews.redacted.body")}
            className="self-stretch"
            testID="rate-redacted"
          />
        ) : null}
      </View>
      <Button
        label={t("reviews.thanks.done")}
        size="lg"
        onPress={() => backToPrevious(fallback)}
        testID="rate-done"
      />
    </ScrollView>
  );
}

type StateProps = {
  fallback: Href;
  title: string;
  body: string;
  action: string;
  onAction: () => void;
  busy?: boolean;
  testID: string;
};

/** A calm full-screen state: what is going on, and one way on. */
function RateState({ fallback, title, body, action, onAction, busy = false, testID }: StateProps) {
  return (
    <ScrollView contentContainerClassName="flex-grow gap-8 px-4 pb-6 pt-2" testID={testID}>
      <BackButton fallbackHref={fallback} />
      <View className="flex-1 justify-center gap-2">
        <Text accessibilityRole="header" className="text-title-1 text-navy-900">
          {title}
        </Text>
        <Text className="text-body text-gray-500">{body}</Text>
      </View>
      <Button label={action} size="lg" variant="secondary" onPress={onAction} loading={busy} />
    </ScrollView>
  );
}

function NotYet({ fallback }: { fallback: Href }) {
  const { t } = useTranslation();
  return (
    <RateState
      fallback={fallback}
      title={t("reviews.notYet.title")}
      body={t("reviews.notYet.body")}
      action={t("reviews.notYet.back")}
      onAction={() => backToPrevious(fallback)}
      testID="rate-not-yet"
    />
  );
}

function GoneState({ fallback }: { fallback: Href }) {
  const { t } = useTranslation();
  return (
    <RateState
      fallback={fallback}
      title={t("reviews.gone.title")}
      body={t("reviews.gone.body")}
      action={t("reviews.gone.home")}
      onAction={() => router.dismissTo("/")}
      testID="rate-gone"
    />
  );
}

type RatedUnavailableProps = {
  fallback: Href;
  retry: () => void;
  busy: boolean;
  /** It just replaced the form (the review was refused on this visit): said once. */
  fresh: boolean;
};

/**
 * The job is rated already but its stars could not be read: nothing to edit or send, only a new
 * read of "mine", and the thanks with the saved stars once one answers.
 */
function RatedUnavailable({ fallback, retry, busy, fresh }: RatedUnavailableProps) {
  const { t } = useTranslation();
  const title = t("reviews.failure.alreadyReviewed.title");
  const body = t("reviews.failure.alreadyReviewed.body");
  const said = useRef(false);
  useEffect(() => {
    if (!fresh || said.current) return;
    said.current = true;
    announce(`${title}. ${body}`);
  }, [body, fresh, title]);

  return (
    <RateState
      fallback={fallback}
      title={title}
      body={body}
      action={t("reviews.retry")}
      onAction={retry}
      busy={busy}
      testID="rate-rated-unavailable"
    />
  );
}

type LoadFailedProps = { fallback: Href; retry: () => void; busy: boolean };

function LoadFailed({ fallback, retry, busy }: LoadFailedProps) {
  const { t } = useTranslation();
  return (
    <RateState
      fallback={fallback}
      title={t("reviews.loadFailed.title")}
      body={t("reviews.loadFailed.body")}
      action={t("reviews.loadFailed.retry")}
      onAction={retry}
      busy={busy}
      testID="rate-load-failed"
    />
  );
}

/** Shaped like the form: the header, the five big stars, the details card; Back works already. */
function RateSkeleton({ fallback }: { fallback: Href }) {
  return (
    <View className="flex-1 gap-2 px-4 pt-2" testID="rate-loading">
      <BackButton fallbackHref={fallback} />
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        className="gap-8"
      >
        <View className="gap-2">
          <TextSkeleton type="title-1" width="60%" />
          <TextSkeleton type="body" width="45%" />
        </View>
        <Skeleton height={STAR_ROW} radius="pill" />
        <Skeleton height={DETAILS_HEIGHT} radius="lg" />
      </View>
    </View>
  );
}
