import type { ParseKeys, TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";

import { Button, Input, Stepper } from "@/components/ui";
import { BackButton } from "@/features/auth/components/BackButton";
import { formatMoneyExact, formatRate } from "@/features/quotes/format";

import { formatDay, formatInstantDay, formatTimeOfDay } from "./format";
import { parsePriceCents, split } from "./money";
import {
  APPROACH_MAX_LENGTH,
  SCOPE_MAX_LENGTH,
  type FieldProblem,
  type QuoteField,
} from "./quoteDraft";
import { DURATION_MINUTES_STEP, START_STEP_MINUTES, type QuoteDraftState } from "./useQuoteDraft";

const MINUTES_PER_HOUR = 60;
const DAY = 1;

type QuoteFormStepProps = {
  quote: QuoteDraftState;
  takeRateBps: number;
  preferredDate: string | null;
  onReview: () => void;
};

/** What each field says about each problem it can have. */
const MESSAGES: Record<QuoteField, Partial<Record<FieldProblem, ParseKeys>>> = {
  price: {
    required: "quoteForm.price.required",
    invalid: "quoteForm.price.invalid",
    aboveCap: "quoteForm.price.aboveCap",
  },
  scope: { required: "quoteForm.scope.required" },
  duration: { required: "quoteForm.duration.required", aboveCap: "quoteForm.duration.aboveCap" },
  start: { past: "quoteForm.start.past" },
};

/** The message for a field's problem, or none. */
function problemText(
  t: TFunction,
  field: QuoteField,
  problem: FieldProblem | undefined,
): string | undefined {
  const key = problem ? MESSAGES[field][problem] : undefined;
  return key ? t(key) : undefined;
}

/**
 * The quote itself: the price with what the pro will receive under it, live; what is included;
 * how the pro will do the job; how long it takes; and when they propose to start.
 */
export function QuoteFormStep({ quote, takeRateBps, preferredDate, onReview }: QuoteFormStepProps) {
  const { t } = useTranslation();
  const { draft, problems, now, duration } = quote;
  const startError = problemText(t, "start", problems.start);
  const durationError = problemText(t, "duration", problems.duration);
  const anyProblem = Object.keys(problems).length > 0;

  return (
    <View className="gap-6" testID="quote-form">
      <BackButton fallbackHref="/" />
      <View className="gap-2">
        <Text accessibilityRole="header" className="text-title-1 text-navy-900">
          {t("quoteForm.title")}
        </Text>
        <Text className="text-callout text-gray-500">{t("quoteForm.subtitle")}</Text>
      </View>

      <View className="gap-3">
        <Input
          label={t("quoteForm.price.label")}
          prefix="$"
          value={draft.price}
          onChangeText={quote.setPrice}
          onBlur={quote.tidyPrice}
          hint={t("quoteForm.price.hint")}
          error={problemText(t, "price", problems.price)}
          keyboardType="decimal-pad"
          inputMode="decimal"
          testID="quote-price"
        />
        <PayoutPreview price={draft.price} takeRateBps={takeRateBps} />
      </View>

      <Input
        label={t("quoteForm.scope.label")}
        value={draft.scope}
        onChangeText={quote.setScope}
        hint={t("quoteForm.scope.hint")}
        error={problemText(t, "scope", problems.scope)}
        multiline
        maxLength={SCOPE_MAX_LENGTH}
        counter
        autoCapitalize="sentences"
        testID="quote-scope"
      />
      <Input
        label={t("quoteForm.approach.label")}
        value={draft.approach}
        onChangeText={quote.setApproach}
        hint={t("quoteForm.approach.hint")}
        multiline
        maxLength={APPROACH_MAX_LENGTH}
        counter
        autoCapitalize="sentences"
        testID="quote-approach"
      />

      <View className="gap-3">
        <Text accessibilityRole="header" className="text-headline text-navy-900">
          {t("quoteForm.duration.title")}
        </Text>
        <Stepper
          label={t("quoteForm.duration.hours")}
          valueText={t("quoteForm.duration.hoursValue", { count: duration.hours })}
          onDecrement={() => quote.stepHours(-1)}
          onIncrement={() => quote.stepHours(1)}
          canDecrement={duration.hours > 0}
          decrementLabel={t("quoteForm.duration.lessHours")}
          incrementLabel={t("quoteForm.duration.moreHours")}
          invalid={durationError !== undefined}
          testID="quote-hours"
        />
        <Stepper
          label={t("quoteForm.duration.minutes")}
          valueText={t("quoteForm.duration.minutesValue", { count: duration.minutes })}
          onDecrement={() => quote.stepMinutes(-1)}
          onIncrement={() => quote.stepMinutes(1)}
          canDecrement={duration.minutes > 0}
          canIncrement={duration.minutes + DURATION_MINUTES_STEP < MINUTES_PER_HOUR}
          decrementLabel={t("quoteForm.duration.lessMinutes", { count: DURATION_MINUTES_STEP })}
          incrementLabel={t("quoteForm.duration.moreMinutes", { count: DURATION_MINUTES_STEP })}
          error={durationError}
          testID="quote-minutes"
        />
      </View>

      <View className="gap-3">
        <Text accessibilityRole="header" className="text-headline text-navy-900">
          {t("quoteForm.start.title")}
        </Text>
        {preferredDate ? (
          <Text className="text-callout text-gray-500" testID="quote-preferred">
            {t("quoteForm.start.preferred", { date: formatDay(preferredDate) })}
          </Text>
        ) : null}
        <Stepper
          label={t("quoteForm.start.day")}
          valueText={formatInstantDay(draft.startAt)}
          onDecrement={() => quote.stepDay(-DAY)}
          onIncrement={() => quote.stepDay(DAY)}
          canDecrement={quote.dayBefore > now}
          decrementLabel={t("quoteForm.start.earlierDay")}
          incrementLabel={t("quoteForm.start.laterDay")}
          invalid={startError !== undefined}
          testID="quote-day"
        />
        <Stepper
          label={t("quoteForm.start.time")}
          valueText={formatTimeOfDay(draft.startAt)}
          onDecrement={() => quote.stepTime(-1)}
          onIncrement={() => quote.stepTime(1)}
          canDecrement={quote.stepEarlier > now}
          decrementLabel={t("quoteForm.start.earlierTime", { count: START_STEP_MINUTES })}
          incrementLabel={t("quoteForm.start.laterTime", { count: START_STEP_MINUTES })}
          error={startError}
          testID="quote-time"
        />
      </View>

      <View className="gap-3">
        {anyProblem ? (
          <Text
            accessibilityRole="alert"
            accessibilityLiveRegion="polite"
            className="text-callout text-danger"
            testID="quote-form-problems"
          >
            {t("quoteForm.review.fix")}
          </Text>
        ) : null}
        <Button
          label={t("quoteForm.review.action")}
          size="lg"
          onPress={onReview}
          testID="quote-review"
        />
      </View>
    </View>
  );
}

type PayoutPreviewProps = { price: string; takeRateBps: number };

/**
 * What the pro will receive for the typed price, "You'll receive $85.00", and Jack's fee under
 * it, worked out as the server will (`split`). Empty until the price is valid; its two lines keep
 * their place meanwhile, so nothing below jumps on the first digit. Android reads each change
 * politely (a live region).
 */
export function PayoutPreview({ price, takeRateBps }: PayoutPreviewProps) {
  const { t } = useTranslation();
  const cents = parsePriceCents(price);
  const preview = cents !== null && cents > 0 ? split(cents, takeRateBps) : null;

  return (
    <View
      accessible={preview !== null}
      accessibilityLiveRegion="polite"
      className="gap-0.5"
      testID="quote-payout"
    >
      {preview ? (
        <>
          <Text className="text-headline text-green-700" testID="quote-payout-receive">
            {t("quoteForm.payout.receive", { amount: formatMoneyExact(preview.proPayoutCents) })}
          </Text>
          <Text className="text-footnote text-gray-500" testID="quote-payout-fee">
            {t("quoteForm.payout.fee", {
              rate: formatRate(takeRateBps),
              amount: formatMoneyExact(preview.platformFeeCents),
            })}
          </Text>
        </>
      ) : (
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <Text className="text-headline opacity-0"> </Text>
          <Text className="text-footnote opacity-0"> </Text>
        </View>
      )}
    </View>
  );
}
