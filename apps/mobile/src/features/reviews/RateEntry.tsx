import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";

import { ControlIcon } from "@/components/icons";
import { StarsShown, useFlag } from "@/components/ui";
import { useGuardedPush } from "@/features/quotes/navigation";
import { continuousCorners, pressedTransform, tokens } from "@/theme";

import { rateHref, useMyReview, type ReviewSide } from "./api";

/** The entry's empty stars: a hint of what the screen asks, not a control. */
const HINT_STARS = 24;

export type RateEntryProps = {
  jobId: string;
  /** The customer's request the job belongs to; the pro's entry has none. */
  requestId?: string;
  side: ReviewSide;
  /** Asks "mine" only while true: for a job that can have been confirmed. */
  enabled?: boolean;
};

/**
 * The way from a job screen to its rating (#77), driven by the job's "mine": while a review can be
 * written, "Rate your pro" (or "your customer") as a lime bubble that opens the rating screen;
 * once one was, "Thanks, you rated 4 stars" with the stars, for good (a review is never edited);
 * otherwise, and while "mine" loads or failed, nothing: the job screen asks nothing more.
 */
export function RateEntry({ jobId, requestId, side, enabled = true }: RateEntryProps) {
  const { t } = useTranslation();
  const push = useGuardedPush();
  const [pressed, pressIn, pressOut] = useFlag();
  const { data } = useMyReview(jobId, enabled);
  if (!data) return null;

  if (data.rated !== null) {
    return (
      <View
        accessible
        accessibilityLabel={t("reviews.entry.rated", { count: data.rated })}
        className="flex-row flex-wrap items-center gap-x-3 gap-y-1"
        testID="rate-entry-done"
      >
        <StarsShown value={data.rated} />
        <Text className="text-callout text-navy-900">
          {t("reviews.entry.rated", { count: data.rated })}
        </Text>
      </View>
    );
  }
  if (!data.canReview) return null;

  const title = t(`reviews.title.${side}`);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityHint={t("reviews.entry.hint")}
      onPress={() => push(rateHref(jobId, requestId))}
      onPressIn={pressIn}
      onPressOut={pressOut}
      style={pressed ? [continuousCorners, pressedTransform] : continuousCorners}
      className="gap-3 rounded-lg bg-green-500/15 p-4"
      testID="rate-entry"
    >
      <View className="flex-row items-center gap-3">
        <View className="flex-1 gap-1">
          <Text className="text-headline text-navy-900">{title}</Text>
          <Text className="text-callout text-gray-500">{t("reviews.entry.hint")}</Text>
        </View>
        <ControlIcon name="chevron" color={tokens.colors["navy-900"]} />
      </View>
      <StarsShown value={0} glyph={HINT_STARS} />
    </Pressable>
  );
}
