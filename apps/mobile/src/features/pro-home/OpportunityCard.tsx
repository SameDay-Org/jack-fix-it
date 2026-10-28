import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";

import { Card, IconTile, Skeleton, StatusBadge, TextSkeleton } from "@/components/ui";
import {
  categoryLabel,
  categoryTileProps,
  formatDay,
  locationLabel,
  sentAgo,
} from "@/features/opportunities/format";

import type { OpportunitySummary } from "./useOpportunities";

export type OpportunityCardProps = {
  opportunity: OpportunitySummary;
  /** The time "sent … ago" is drawn at. */
  now: number;
  onPress: (opportunity: OpportunitySummary) => void;
};

// Shown to sighted users only: the card's label already says it all.
const VISUAL_ONLY = {
  accessibilityElementsHidden: true,
  importantForAccessibility: "no-hide-descendants",
} as const;

const EXCERPT_LINES = 2;
/** The icon tile's side (`IconTile` md), for the skeleton. */
const TILE_SIDE = 56;
/** About the "New" pill: one caption line with the badge's vertical padding, and its width. */
const NEW_PLACEHOLDER = { width: 44, height: 24 } as const;

type CardText = {
  category: string;
  place: string;
  /** "Preferred Fri, Oct 30", when the customer named a day. */
  preferred: string | null;
  sent: string;
  /** The whole card as one sentence: category, place, date, when it was sent, new. */
  summary: string;
};

function cardText(t: TFunction, opportunity: OpportunitySummary, now: number): CardText {
  const category = categoryLabel(t, opportunity.category);
  const place = locationLabel(opportunity.location);
  const preferred = opportunity.preferred_date
    ? t("opportunities.preferred", { date: formatDay(opportunity.preferred_date) })
    : null;
  const sent = t("opportunities.sentAgo", { ago: sentAgo(t, opportunity.sent_at, now) });
  const isNew = opportunity.viewed ? null : t("opportunities.new");
  return {
    category,
    place,
    preferred,
    sent,
    summary: `${[category, place, preferred, sent, isNew].filter(Boolean).join(", ")}.`,
  };
}

/**
 * One opportunity as a white bubble that opens its detail: the category's tile and name (with a
 * "New" pill until the pro opens it), the start of the description, then where, when and how
 * long ago it was sent, one line each. Nothing about the customer: the city and the ZIP (#49).
 */
export function OpportunityCard({ opportunity, now, onPress }: OpportunityCardProps) {
  const { t } = useTranslation();
  const text = cardText(t, opportunity, now);
  const testID = `opportunity-${opportunity.dispatch_id}`;

  return (
    <Card onPress={() => onPress(opportunity)} accessibilityLabel={text.summary} testID={testID}>
      <View {...VISUAL_ONLY} className="flex-row gap-3">
        <IconTile {...categoryTileProps(opportunity.category)} />
        <View className="flex-1 gap-1">
          {/* The pill wraps under a long name rather than squeezing it. */}
          <View className="flex-row flex-wrap items-center gap-x-2 gap-y-1">
            <Text className="shrink text-headline text-navy-900" testID={`${testID}-category`}>
              {text.category}
            </Text>
            {opportunity.viewed ? null : (
              <StatusBadge label={t("opportunities.new")} tone="brand" testID={`${testID}-new`} />
            )}
          </View>
          <Text
            className="text-callout text-navy-900"
            numberOfLines={EXCERPT_LINES}
            testID={`${testID}-excerpt`}
          >
            {opportunity.description_excerpt}
          </Text>
          <Text className="text-footnote text-gray-500" testID={`${testID}-place`}>
            {text.place}
          </Text>
          {text.preferred ? (
            <Text className="text-footnote text-gray-500" testID={`${testID}-preferred`}>
              {text.preferred}
            </Text>
          ) : null}
          <Text className="text-footnote text-gray-500" testID={`${testID}-sent`}>
            {text.sent}
          </Text>
        </View>
      </View>
    </Card>
  );
}

/**
 * A card-shaped placeholder with the loaded card's rows: the tile, the name beside a pill (the
 * newest rows carry "New"), a two-line excerpt and the three footnote lines, each a
 * `TextSkeleton` of the same type style, so the row is as tall as the text that replaces it at
 * any font scale.
 */
export function OpportunityCardSkeleton({ testID }: { testID?: string }) {
  return (
    <Card testID={testID}>
      <View className="flex-row gap-3">
        <Skeleton width={TILE_SIDE} height={TILE_SIDE} radius="md" />
        <View className="flex-1 gap-1">
          <View className="flex-row items-center gap-x-2">
            <View className="w-1/2">
              <TextSkeleton type="headline" />
            </View>
            <Skeleton {...NEW_PLACEHOLDER} radius="pill" />
          </View>
          {/* One block, no gap: the two lines of one wrapped text sit flush. */}
          <View>
            <TextSkeleton type="callout" />
            <TextSkeleton type="callout" width="65%" />
          </View>
          <TextSkeleton type="footnote" width="45%" />
          <TextSkeleton type="footnote" width="60%" />
          <TextSkeleton type="footnote" width="40%" />
        </View>
      </View>
    </Card>
  );
}
