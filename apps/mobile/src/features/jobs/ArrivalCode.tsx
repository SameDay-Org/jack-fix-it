import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";

export type ArrivalCodeProps = {
  /** The 4 digits, as the API sends them while the pro is on the way. */
  code: string;
  /** The pro as named inside a sentence ("Dan", "your pro"). */
  proName: string;
};

// Tabular figures: the four tiles hold digits of one width.
const DIGITS = { fontVariant: ["tabular-nums"] } as const;

/**
 * The arrival code, big and readable: one tile per digit and the line saying who gets it. Screen
 * readers hear the digits one by one ("Arrival code: 0, 4, 2, 7"), never as a number. Shown on
 * the job screen only: never in the banner, a notification or a log.
 */
export function ArrivalCode({ code, proName }: ArrivalCodeProps) {
  const { t } = useTranslation();
  const digits = Array.from(code);

  return (
    <View className="gap-3" testID="arrival-code">
      <Text className="text-headline text-navy-900">{t("jobs.code.title")}</Text>
      <View
        accessible
        accessibilityRole="text"
        accessibilityLabel={t("jobs.code.label", { digits: digits.join(", ") })}
        className="max-w-xs flex-row gap-2"
        testID="arrival-code-digits"
      >
        {digits.map((digit, index) => (
          <View
            key={index}
            className="flex-1 items-center justify-center rounded-lg bg-gray-50 py-3"
          >
            <Text className="text-display text-navy-900" style={DIGITS}>
              {digit}
            </Text>
          </View>
        ))}
      </View>
      <Text className="text-callout text-gray-500">{t("jobs.code.hint", { name: proName })}</Text>
    </View>
  );
}
