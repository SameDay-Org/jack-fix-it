import { useTranslation } from "react-i18next";
import { Text, useWindowDimensions, View } from "react-native";

import { cx } from "@/components/ui/cx";
import { tokens } from "@/theme";

import type { TimelineItem } from "./phase";

export type JobTimelineProps = {
  /** Newest first (`timelineOf`). */
  items: readonly TimelineItem[];
};

// The dot sits on the first line's center: (callout line height at the font scale - dot) / 2.
const DOT = 10;
const LINE = tokens.fontSize.callout.lineHeight;

/**
 * What happened so far, newest first: a dot per event on a thin line, the event and its local
 * time. The newest dot is green. Each row reads as one sentence ("On the way, 3:12 PM").
 */
export function JobTimeline({ items }: JobTimelineProps) {
  const { t } = useTranslation();
  const { fontScale } = useWindowDimensions();
  const dotTop = (Math.ceil(LINE * fontScale) - DOT) / 2;
  if (items.length === 0) return null;

  return (
    <View className="gap-3" testID="job-timeline">
      <Text accessibilityRole="header" className="text-headline text-navy-900">
        {t("jobs.timeline.title")}
      </Text>
      <View>
        {items.map((item, index) => {
          const last = index === items.length - 1;
          return (
            <View
              key={item.key}
              accessible
              accessibilityLabel={t("jobs.timeline.row", { event: item.label, time: item.time })}
              className="flex-row gap-3"
              testID={`job-timeline-${index}`}
            >
              <View className="items-center" style={{ width: DOT }}>
                <View
                  className={cx("rounded-pill", index === 0 ? "bg-green-700" : "bg-gray-500/40")}
                  style={{ width: DOT, height: DOT, marginTop: dotTop }}
                />
                {last ? null : <View className="mt-1 w-0.5 flex-1 rounded-pill bg-gray-500/20" />}
              </View>
              <View className={cx("flex-1 flex-row gap-3", last ? "" : "pb-4")}>
                <Text className="flex-1 text-callout text-navy-900">{item.label}</Text>
                <Text className="text-footnote text-gray-500">{item.time}</Text>
              </View>
            </View>
          );
        })}
      </View>
    </View>
  );
}
