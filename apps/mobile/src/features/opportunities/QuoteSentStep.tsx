import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import Svg, { Path } from "react-native-svg";

import { Button } from "@/components/ui";
import { formatMoneyExact } from "@/features/quotes/format";
import { tokens } from "@/theme";

import type { SentQuote } from "./useSendQuote";

const BADGE_GLYPH = 32;

type QuoteSentStepProps = {
  /** The server's answer: its payout is the one shown, not the form's preview. */
  quote: SentQuote;
  onDone: () => void;
};

/** The quote went out: its price, what the pro will receive per the server, and what happens next. */
export function QuoteSentStep({ quote, onDone }: QuoteSentStepProps) {
  const { t } = useTranslation();

  return (
    <View className="flex-grow gap-8 pt-10" testID="quote-sent">
      <View className="gap-5">
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          className="h-16 w-16 items-center justify-center rounded-pill bg-green-500"
        >
          <Svg width={BADGE_GLYPH} height={BADGE_GLYPH} viewBox="0 0 24 24">
            <Path
              d="M5 12.5l4.5 4.5L19 7.5"
              stroke={tokens.colors["navy-900"]}
              strokeWidth={2.5}
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
            />
          </Svg>
        </View>
        <Text accessibilityRole="header" className="text-display text-white">
          {t("quoteForm.sent.title")}
        </Text>
      </View>

      <View className="gap-4">
        <View accessible className="gap-0.5" testID="quote-sent-price">
          <Text className="text-callout text-white">{t("quoteForm.sent.price")}</Text>
          <Text className="text-title-2 text-white">{formatMoneyExact(quote.amount_cents)}</Text>
        </View>
        <View accessible className="gap-0.5" testID="quote-sent-payout">
          <Text className="text-callout text-white">{t("quoteForm.sent.receive")}</Text>
          <Text className="text-title-1 text-green-500">
            {formatMoneyExact(quote.pro_payout_cents)}
          </Text>
        </View>
      </View>

      <Text className="text-body text-white">{t("quoteForm.sent.body")}</Text>

      <Button
        label={t("quoteForm.sent.home")}
        size="lg"
        onPress={onDone}
        className="mt-auto"
        testID="quote-sent-home"
      />
    </View>
  );
}
