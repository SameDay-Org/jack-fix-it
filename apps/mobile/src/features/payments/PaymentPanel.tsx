import { useFocusEffect } from "expo-router";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Text, View } from "react-native";

import { Button, Notice, Skeleton } from "@/components/ui";
import { NotificationsPrompt } from "@/features/notifications/NotificationsPrompt";
import { formatDateTime, formatMoney } from "@/features/quotes/format";
import { continuousCorners, tokens } from "@/theme";

import {
  takeAutoPay,
  useAutoPayPending,
  usePaymentSummary,
  type PaymentSummary,
} from "./paymentStore";
import { useJobConfirmation } from "./useJobConfirmation";
import type { CustomerJob } from "./useRequestJob";
import { usePayQuote, type PayFailure } from "./usePayQuote";

export type PaymentPanelProps = {
  requestId: string;
  quoteId: string;
  /** The quote's price, shown on Pay until the API sends the total for the sheet. */
  amountCents: number;
  /** The pro's name as the card shows it: Pay's spoken label and the booked line. */
  pro: string;
  testID: string;
};

// Seen, not read: the card's summary label already says the quote was accepted.
const VISUAL_ONLY = {
  accessibilityElementsHidden: true,
  importantForAccessibility: "no-hide-descendants",
} as const;

/** The kit's large pill (min-h-14): the placeholder Pay leaves while the job is first looked up. */
const PAY_PLACEHOLDER_HEIGHT = 56;
/** About the note bubble's height (one callout line and its padding) while the job is looked up. */
const NOTE_PLACEHOLDER_HEIGHT = 48;

/** What the customer sees for a job past Scheduled (docs/glossary.md, the job mapping). */
const JOB_STATUS_KEYS = {
  scheduled: "customerStatus.scheduled",
  on_the_way: "customerStatus.professionalOnTheWay",
  in_progress: "customerStatus.inProgress",
  completed: "customerStatus.waitingForConfirmation",
  confirmed: "customerStatus.completed",
  paid_out: "customerStatus.completed",
  disputed: "customerStatus.needsAttention",
  refunded: "customerStatus.cancelled",
  cancelled: "customerStatus.cancelled",
} as const satisfies Record<CustomerJob["status"], string>;

// Nothing for the customer to fix, so no alarm: the info tint. A failed payment is the danger one.
const CALM_FAILURES: ReadonlySet<PayFailure> = new Set([
  "notConfigured",
  "needsReview",
  "proNotHireable",
]);

/**
 * The accepted quote's payment, at the foot of its card: Pay while there is no job (a customer
 * who closed the sheet pays later from here), then "Confirming your payment…" while the job is
 * on its way, then "You're booked". A quote accepted a moment ago opens the sheet as soon as the
 * request screen is back in front (`requestAutoPay`). The total shows above Pay once the API has
 * priced the sheet; a failure says what happened in a notice, and Pay stays.
 */
export function PaymentPanel({ requestId, quoteId, amountCents, pro, testID }: PaymentPanelProps) {
  const { t } = useTranslation();
  const { phase, job } = useJobConfirmation(requestId, quoteId);
  const { busy, failure, pay } = usePayQuote(requestId, quoteId);
  const summary = usePaymentSummary(quoteId);
  const unpaid = phase === "unpaid" || phase === "loading";
  const autoPayPending = useAutoPayPending(quoteId);

  // Once the request screen is in front again, whichever comes last: the focus, or the hand-off.
  useFocusEffect(
    useCallback(() => {
      if (!unpaid || !autoPayPending) return;
      const auto = takeAutoPay(quoteId);
      if (auto) void pay(auto.generation);
    }, [autoPayPending, pay, quoteId, unpaid]),
  );

  if (phase === "booked" && job) {
    // Once booked, the job's updates are what notifications bring: the pre-prompt asks here (#334).
    return (
      <View className="gap-3">
        <View
          style={continuousCorners}
          className="gap-1 rounded-md bg-green-500/10 p-3"
          testID={`${testID}-booked`}
        >
          <Text accessibilityRole="header" className="text-headline text-navy-900">
            {job.status === "scheduled"
              ? t("payment.booked.title")
              : t(JOB_STATUS_KEYS[job.status])}
          </Text>
          {/* The date is the plan only while the job is Scheduled; its own screens come with #64. */}
          {job.status === "scheduled" ? (
            <Text className="text-callout text-navy-900">
              {t("payment.booked.body", { pro, date: formatDateTime(job.scheduled_start_at) })}
            </Text>
          ) : null}
        </View>
        <NotificationsPrompt audience="customer" testID={`${testID}-notifications`} />
      </View>
    );
  }
  if (phase === "confirming") {
    return (
      <Notice
        tone="info"
        title={t("payment.confirming.title")}
        body={t("payment.confirming.body")}
        testID={`${testID}-confirming`}
      >
        <ActivityIndicator
          {...VISUAL_ONLY}
          color={tokens.colors["navy-900"]}
          testID={`${testID}-confirming-spinner`}
        />
      </Notice>
    );
  }
  if (phase === "delayed") {
    return (
      <Notice
        tone="info"
        title={t("payment.delayed.title")}
        body={t("payment.delayed.body")}
        testID={`${testID}-delayed`}
      />
    );
  }

  // The first look at the job claims nothing: a paid quote must not read "Payment comes next".
  if (phase === "loading") {
    return (
      <View className="gap-3" testID={`${testID}-loading`}>
        <Skeleton width="100%" height={NOTE_PLACEHOLDER_HEIGHT} radius="md" />
        <Skeleton
          width="100%"
          height={PAY_PLACEHOLDER_HEIGHT}
          radius="pill"
          testID={`${testID}-pay-placeholder`}
        />
      </View>
    );
  }

  const price = formatMoney(summary?.customer_total_cents ?? amountCents);
  return (
    <View className="gap-3">
      <View {...VISUAL_ONLY} style={continuousCorners} className="rounded-md bg-green-500/10 p-3">
        <Text className="text-callout text-navy-900" testID={`${testID}-accepted-note`}>
          {t("quotes.acceptedNote")}
        </Text>
      </View>
      {summary ? <PaymentTotal summary={summary} testID={`${testID}-total`} /> : null}
      {failure ? (
        <Notice
          tone={CALM_FAILURES.has(failure) ? "info" : "danger"}
          title={t(`payment.failure.${failure}.title`)}
          body={t(`payment.failure.${failure}.body`)}
          testID={`${testID}-failure`}
        />
      ) : null}
      <Button
        label={t("payment.pay", { price })}
        accessibilityLabel={t("payment.payLabel", { price, pro })}
        size="lg"
        loading={busy}
        onPress={() => void pay()}
        testID={`${testID}-pay`}
      />
    </View>
  );
}

/**
 * What the customer will pay, as the API priced it: the total, and the price and the tax under it
 * only when there is a tax (none in the MVP). One label for screen readers.
 */
function PaymentTotal({ summary, testID }: { summary: PaymentSummary; testID: string }) {
  const { t } = useTranslation();
  const total = formatMoney(summary.customer_total_cents);
  const taxed = summary.tax_cents > 0;
  const breakdown = taxed
    ? t("payment.breakdown", {
        price: formatMoney(summary.amount_cents),
        tax: formatMoney(summary.tax_cents),
      })
    : null;
  const label = t("payment.total", { total });

  return (
    <View
      accessible
      accessibilityLabel={breakdown ? `${label}, ${breakdown}` : label}
      className="gap-1"
      testID={testID}
    >
      <Text className="text-headline text-navy-900">{label}</Text>
      {breakdown ? (
        <Text className="text-footnote text-gray-500" testID={`${testID}-breakdown`}>
          {breakdown}
        </Text>
      ) : null}
    </View>
  );
}
