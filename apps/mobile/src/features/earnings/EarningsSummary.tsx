import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";

import { Card, TextSkeleton } from "@/components/ui";
import { bubbleShadow, continuousCorners } from "@/theme";

import type { EarningStatus, EarningsSummary as Summary } from "./api";
import { FIGURES, money } from "./format";

const [PAID, ...OTHERS] = FIGURES;
// The hero figure keeps to one line: past the panel's width it shrinks, never breaks mid-number.
const PAID_MIN_SCALE = 0.5;

/**
 * The four totals over all the pro's jobs, as the API sums them (never added up from the loaded
 * rows): what was paid in a navy panel, then what is on its way, awaiting the customer and under
 * review. Each reads as one: "Paid, $120.00. Sent to your payout account." Without a summary yet,
 * the same layout with the amounts as placeholders, read as one "Loading" indicator.
 */
export function EarningsSummary({ summary }: { summary: Summary | undefined }) {
  const { t } = useTranslation();
  const amount = (field: (typeof FIGURES)[number]["field"]) =>
    summary ? money(summary[field], summary.currency) : undefined;
  const label = (key: EarningStatus, value: string | undefined) =>
    value === undefined
      ? undefined
      : `${t(`earnings.figure.${key}.label`)}, ${value}. ${t(`earnings.figure.${key}.body`)}`;
  const paid = amount(PAID.field);

  return (
    <View
      accessible={summary === undefined}
      accessibilityRole={summary === undefined ? "progressbar" : undefined}
      accessibilityLabel={summary === undefined ? t("earnings.loading") : undefined}
      className="gap-4"
      testID={summary === undefined ? "earnings-summary-loading" : "earnings-summary"}
    >
      <View
        accessible
        accessibilityLabel={label(PAID.key, paid)}
        style={[bubbleShadow, continuousCorners]}
        className="gap-1 rounded-lg bg-navy-900 p-5"
        testID="earnings-figure-paid"
      >
        <Text className="text-headline text-white">{t("earnings.figure.paid.label")}</Text>
        {paid === undefined ? (
          <TextSkeleton type="display" width="60%" tone="dark" />
        ) : (
          <Text
            adjustsFontSizeToFit
            minimumFontScale={PAID_MIN_SCALE}
            numberOfLines={1}
            className="text-display text-green-500"
            testID="earnings-figure-paid-amount"
          >
            {paid}
          </Text>
        )}
        <Text className="text-callout text-white">{t("earnings.figure.paid.body")}</Text>
      </View>
      <Card className="gap-5">
        {OTHERS.map(({ key, field }) => {
          const value = amount(field);
          return (
            <View
              key={key}
              accessible
              accessibilityLabel={label(key, value)}
              className="gap-1"
              testID={`earnings-figure-${key}`}
            >
              <Text className="text-callout font-semibold text-navy-900">
                {t(`earnings.figure.${key}.label`)}
              </Text>
              {value === undefined ? (
                <TextSkeleton type="title-2" width="40%" />
              ) : (
                <Text
                  className="text-title-2 text-navy-900"
                  testID={`earnings-figure-${key}-amount`}
                >
                  {value}
                </Text>
              )}
              <Text className="text-footnote text-gray-500">
                {t(`earnings.figure.${key}.body`)}
              </Text>
            </View>
          );
        })}
      </Card>
    </View>
  );
}
