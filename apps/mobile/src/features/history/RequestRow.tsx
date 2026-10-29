import type { TFunction } from "i18next";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, Text, View } from "react-native";

import {
  ICON_TILE,
  IconTile,
  Skeleton,
  StatusBadge,
  StatusBadgeSkeleton,
  TextSkeleton,
} from "@/components/ui";
import { deviceLocale } from "@/features/auth/locale";
import type { Category } from "@/features/home/useCategories";
import { joinFacts } from "@/features/quotes/format";
import { withOpacity } from "@/theme";

import {
  findCategory,
  requestCategoryLabel,
  requestTileProps,
  sentDay,
  statusChip,
  type StatusChip,
} from "./format";
import type { RequestSummary } from "./useMyRequests";

export type RequestRowProps = {
  request: RequestSummary;
  /** The active catalog, where the row finds its category's name and glyph. */
  categories: readonly Category[];
  /** The time "Today" and "Yesterday" are counted from. */
  now: number;
  onPress: (request: RequestSummary) => void;
};

// Shown to sighted users only: the row's label already says it all.
const VISUAL_ONLY = {
  accessibilityElementsHidden: true,
  importantForAccessibility: "no-hide-descendants",
} as const;

const TILE = ICON_TILE.md;
/** The row's side padding and the gap after its tile: the separator starts under the text. */
const ROW_INSET = 16;
const TILE_GAP = 12;
const PRESSED = { backgroundColor: withOpacity("gray-500", 0.1) };
const styles = StyleSheet.create({
  separator: {
    height: StyleSheet.hairlineWidth,
    marginLeft: ROW_INSET + TILE.side + TILE_GAP,
    backgroundColor: withOpacity("gray-500", 0.15),
  },
});

/**
 * The placeholder's sample rows, in the app's language: the general-repairs category of the seed,
 * whose name is among the catalog's longest in Spanish, and a code with the longest day word.
 */
const SAMPLE_CATEGORY: Record<ReturnType<typeof deviceLocale>, string> = {
  en: "Handyman",
  es: "Reparaciones generales",
};
const SAMPLE_CODE = "JF-000124";

type RowText = {
  category: string;
  /** "JF-000124 · Oct 28" */
  facts: string;
  chip: StatusChip | null;
  /** The whole row as one phrase: "Handyman, JF-000124, Quote Ready, Oct 28". */
  summary: string;
};

function rowText(
  t: TFunction,
  request: RequestSummary,
  categories: readonly Category[],
  now: number,
): RowText {
  const category = requestCategoryLabel(t, findCategory(categories, request.category_id));
  const day = sentDay(t, request.created_at, now);
  const chip = statusChip(t, request.customer_status);
  return {
    category,
    facts: joinFacts([request.public_code, day]),
    chip,
    summary: [category, request.public_code, chip?.label, day].filter(Boolean).join(", "),
  };
}

/**
 * One request in the History list, a quiet row rather than a bubble: the category's tile, its
 * name, the code and the day it was sent, and the status as a chip. It opens the request.
 */
export function RequestRow({ request, categories, now, onPress }: RequestRowProps) {
  const { t } = useTranslation();
  const text = rowText(t, request, categories, now);
  const testID = `request-${request.id}`;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={text.summary}
      onPress={() => onPress(request)}
      // A style, not a class: a class toggled after mount remounts the row under NativeWind.
      style={({ pressed }) => (pressed ? PRESSED : undefined)}
      testID={testID}
    >
      <RowLayout
        tile={<IconTile {...requestTileProps(findCategory(categories, request.category_id))} />}
        name={
          <Text className="text-headline text-navy-900" testID={`${testID}-category`}>
            {text.category}
          </Text>
        }
        facts={
          <Text className="text-footnote text-gray-500" testID={`${testID}-facts`}>
            {text.facts}
          </Text>
        }
        chip={
          text.chip ? (
            <StatusBadge
              label={text.chip.label}
              tone={text.chip.tone}
              testID={`${testID}-status`}
            />
          ) : null
        }
      />
    </Pressable>
  );
}

type RowLayoutProps = {
  tile: ReactNode;
  name: ReactNode;
  facts: ReactNode;
  chip: ReactNode;
  testID?: string;
};

/** The row's frame, shared with its placeholder so the two are the same height. */
function RowLayout({ tile, name, facts, chip, testID }: RowLayoutProps) {
  return (
    <View {...VISUAL_ONLY} testID={testID} className="flex-row items-center gap-3 px-4 py-3">
      {tile}
      <View className="flex-1 gap-1">
        {name}
        {facts}
        {chip}
      </View>
    </View>
  );
}

/** The hairline between rows, from under the text to the edge. */
export const RequestRowSeparator = () => <View style={styles.separator} />;

/**
 * A placeholder with the loaded row's lines: the tile, the name, the code with the day and the
 * chip. Each line is a skeleton of the same type style over a sample of the same words, so it
 * takes the height and the line breaks the loaded row will at any font scale.
 */
export function RequestRowSkeleton({ testID }: { testID?: string }) {
  const { t } = useTranslation();

  return (
    <RowLayout
      testID={testID}
      tile={<Skeleton width={TILE.side} height={TILE.side} radius={TILE.radius} />}
      name={
        <TextSkeleton
          type="headline"
          sample={SAMPLE_CATEGORY[deviceLocale()]}
          testID={testID && `${testID}-category`}
        />
      }
      facts={
        <TextSkeleton
          type="footnote"
          sample={joinFacts([SAMPLE_CODE, t("history.customer.yesterday")])}
        />
      }
      chip={<StatusBadgeSkeleton label={t("customerStatus.findingAPro")} />}
    />
  );
}
