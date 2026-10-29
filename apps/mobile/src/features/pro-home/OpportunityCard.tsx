import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";

import {
  Card,
  IconTile,
  Skeleton,
  StatusBadge,
  StatusBadgeSkeleton,
  TextSkeleton,
} from "@/components/ui";
import { deviceLocale } from "@/features/auth/locale";
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
/**
 * The name a placeholder's first row holds, in the app's language: the general-repairs category
 * of the seed (`apps/api/app/modules/categories/seed_data.json`), whose name breaks where most of
 * the catalog's do on a 320 dp phone at font scale 1: beside the "New" pill in English, above it
 * in Spanish. A card cannot know its name before it arrives; this reserves the rows it takes
 * most often.
 */
const SAMPLE_CATEGORY: Record<ReturnType<typeof deviceLocale>, string> = {
  en: "Handyman",
  es: "Reparaciones generales",
};
/** A day whose short form is as wide as they come in either language: a four-letter month, two digits. */
const SAMPLE_DAY = "2026-09-30";

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
 * A card-shaped placeholder with the loaded card's rows: the tile, the name beside the "New" pill
 * (the newest rows carry it), a two-line excerpt and the three footnote lines. Each line is a
 * `TextSkeleton` of the same type style, so it is as tall as the text that replaces it at any
 * font scale; the two rows that wrap on a narrow phone (the name with its pill, the preferred
 * date) stand in for a sample of the same words in the same classes, so they break where the
 * loaded card's will.
 */
export function OpportunityCardSkeleton({ testID }: { testID?: string }) {
  const { t } = useTranslation();
  const preferred = t("opportunities.preferred", { date: formatDay(SAMPLE_DAY) });

  return (
    <Card testID={testID}>
      <View className="flex-row gap-3">
        <Skeleton width={TILE_SIDE} height={TILE_SIDE} radius="md" />
        <View className="flex-1 gap-1">
          <View className="flex-row flex-wrap items-center gap-x-2 gap-y-1">
            <TextSkeleton
              type="headline"
              sample={SAMPLE_CATEGORY[deviceLocale()]}
              className="shrink"
              testID={testID && `${testID}-category`}
            />
            <StatusBadgeSkeleton label={t("opportunities.new")} />
          </View>
          {/* One block, no gap: the two lines of one wrapped text sit flush. */}
          <View>
            <TextSkeleton type="callout" />
            <TextSkeleton type="callout" width="65%" />
          </View>
          <TextSkeleton type="footnote" width="45%" />
          <TextSkeleton
            type="footnote"
            sample={preferred}
            testID={testID && `${testID}-preferred`}
          />
          <TextSkeleton type="footnote" width="40%" />
        </View>
      </View>
    </Card>
  );
}
