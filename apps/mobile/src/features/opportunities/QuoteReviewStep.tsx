import { useTranslation } from "react-i18next";
import { ScrollView, Text, View } from "react-native";

import { Button, Card } from "@/components/ui";
import { BackButton } from "@/features/auth/components/BackButton";
import { formatDateTime, formatMinutes, formatMoneyExact } from "@/features/quotes/format";

import { split } from "./money";
import type { QuoteCreate } from "./quoteDraft";

type QuoteReviewStepProps = {
  body: QuoteCreate;
  takeRateBps: number;
  sending: boolean;
  /** The last send got no answer or a 503: the same quote can go again. */
  failed: boolean;
  onSend: () => void;
  onEdit: () => void;
};

/**
 * The quote as it will go out, with one sentence on top ("Send quote for $100.00 · you'll
 * receive $85.00"), then Send and Edit under the scrolling quote, always in view. Sending disables
 * both; a failed send keeps everything and says so, and Send becomes Try again.
 */
export function QuoteReviewStep({
  body,
  takeRateBps,
  sending,
  failed,
  onSend,
  onEdit,
}: QuoteReviewStepProps) {
  const { t } = useTranslation();
  const { proPayoutCents } = split(body.amount_cents, takeRateBps);

  return (
    <>
      <ScrollView contentContainerClassName="gap-6 px-4 pb-6 pt-2" testID="quote-review-step">
        <BackButton beforeBack={() => (sending ? undefined : onEdit())} />
        <View className="gap-2">
          <Text accessibilityRole="header" className="text-title-1 text-navy-900">
            {t("quoteForm.review.title")}
          </Text>
          <Text className="text-callout text-gray-500">{t("quoteForm.review.subtitle")}</Text>
        </View>

        <View className="rounded-lg bg-navy-900 p-5" testID="quote-review-summary">
          <Text className="text-title-2 text-white">
            {t("quoteForm.review.summary", {
              price: formatMoneyExact(body.amount_cents),
              payout: formatMoneyExact(proPayoutCents),
            })}
          </Text>
        </View>

        <Card className="gap-4">
          <Row label={t("quoteForm.scope.label")} value={body.scope} testID="quote-review-scope" />
          {body.approach ? (
            <Row
              label={t("quoteForm.approach.label")}
              value={body.approach}
              testID="quote-review-approach"
            />
          ) : null}
          <Row
            label={t("quoteForm.review.duration")}
            value={formatMinutes(t, body.duration_minutes)}
            testID="quote-review-duration"
          />
          <Row
            label={t("quoteForm.review.start")}
            value={formatDateTime(body.proposed_start_at)}
            testID="quote-review-start"
          />
        </Card>
      </ScrollView>

      <View className="gap-3 px-4 pb-4 pt-3">
        {failed ? (
          <Text
            accessibilityRole="alert"
            accessibilityLiveRegion="polite"
            className="text-callout text-danger"
            testID="quote-send-failed"
          >
            {t("quoteForm.review.failed")}
          </Text>
        ) : null}
        <Button
          label={failed ? t("quoteForm.review.retry") : t("quoteForm.review.send")}
          size="lg"
          onPress={onSend}
          loading={sending}
          testID="quote-send"
        />
        <Button
          label={t("quoteForm.review.edit")}
          variant="secondary"
          size="lg"
          onPress={onEdit}
          disabled={sending}
          testID="quote-edit"
        />
      </View>
    </>
  );
}

type RowProps = { label: string; value: string; testID: string };

/** One part of the quote, read as "What's included, Paint the hallway…". */
function Row({ label, value, testID }: RowProps) {
  return (
    <View accessible className="gap-0.5" testID={testID}>
      <Text className="text-footnote text-gray-500">{label}</Text>
      <Text className="text-body text-navy-900">{value}</Text>
    </View>
  );
}
