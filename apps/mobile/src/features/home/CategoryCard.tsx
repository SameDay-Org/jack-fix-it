import { Pressable, Text, useWindowDimensions, View } from "react-native";
import Animated from "react-native-reanimated";

import { ICON_TILE, IconTile, useFlag, useSkeletonPulse } from "@/components/ui";
import { bubbleShadow, continuousCorners, pressedTransform, tokens } from "@/theme";

/** Cards per row. Phones only: a tablet still gets two columns. */
export const CARD_COLUMNS = 2;
/** The space between cards, across and down (gap-3 on the 4-pt grid). */
export const CARD_GAP = 12;
/** The inset between the bubble's edge and its content (12 dp: the tile's own squircle keeps it clear of the 24 dp corner). */
export const CARD_PADDING = 12;
/** Lines the name slot reserves when every launch name fits them: a one-line and a two-line name make equal cards. */
export const NAME_MIN_LINES = 2;
/** The longest name a card shows before an ellipsis, and the lines the slot reserves on a narrow card. */
export const NAME_MAX_LINES = 3;

/** The name's type: the body size at a semibold weight. The slot below reserves its line height. */
const NAME_TYPE = "text-body font-semibold text-navy-900";
const NAME_LINE_HEIGHT = tokens.fontSize.body.lineHeight;

/**
 * The widest single word of the launch catalog in either language ("Reparaciones"), in the name's
 * type at font scale 1: 104 dp in Roboto at weight 600, as the Android emulator draws it. A slot
 * narrower than this word at the current scale breaks the word (with a hyphen on Android), which
 * costs a third line. Update it with the seed (`apps/api/app/modules/categories/seed_data.json`).
 */
const LONGEST_WORD_WIDTH = 104;

/**
 * The side of a square card when CARD_COLUMNS of them share a row of `rowWidth` dp with CARD_GAP
 * between them, floored to a whole dp so the row never overflows by a sub-pixel.
 */
export function cardSide(rowWidth: number): number {
  return Math.max(0, Math.floor((rowWidth - CARD_GAP * (CARD_COLUMNS - 1)) / CARD_COLUMNS));
}

/**
 * How many lines the name slot of a card of `side` dp reserves at a font scale: two, or three when
 * the slot cannot hold the catalog's longest word on one line (a 320 dp phone at 1.3). The linear
 * `fontScale` is at or above what Android 14+ applies to 16 sp, so the estimate errs towards the
 * third line, never towards a card that grows when its name arrives.
 */
export function nameSlotLines(side: number, fontScale: number): number {
  const slotWidth = side - 2 * CARD_PADDING;
  return slotWidth < LONGEST_WORD_WIDTH * fontScale ? NAME_MAX_LINES : NAME_MIN_LINES;
}

/**
 * The height the name slot reserves: `nameSlotLines` lines of the name's type at the font scale.
 * The linear scale is at or above what Android 14+ applies to a 24 sp line, so the slot always
 * holds that many real lines, and a skeleton (which cannot know a name's line count) sizes itself
 * with the same number.
 */
export function nameSlotMinHeight(side: number, fontScale: number): number {
  return nameSlotLines(side, fontScale) * NAME_LINE_HEIGHT * fontScale;
}

// One cell recipe for the card and its skeleton: the bubble radius, the inset, the tile at the
// top and the name slot at the bottom, at least 8 dp apart. The size and the inset are styles
// because they take part in the slot arithmetic above.
const CELL = "justify-between gap-2 rounded-lg";
const SURFACE_STYLE = [bubbleShadow, continuousCorners];
const TILE = ICON_TILE.md;

export type CategoryCardProps = {
  /** The category slug: picks the icon, and a slug without one gets the tile's generic mark. */
  slug: string;
  /** The localized name: the visible text and the accessible name of the card. */
  name: string;
  /** The square's side in dp, from `cardSide` of the measured row. */
  side: number;
  onPress: () => void;
  testID?: string;
};

/**
 * A square white bubble with the category's icon tile at the top-left and its name at the
 * bottom-left. Its width is fixed and its height is at least its width: a name past two lines
 * makes it taller, and the row it sits in stretches its neighbour to match. The whole card is one
 * button named after the category; the icon is decorative.
 */
export function CategoryCard({ slug, name, side, onPress, testID }: CategoryCardProps) {
  const [pressed, pressIn, pressOut] = useFlag();
  const { fontScale } = useWindowDimensions();
  const cell = [...SURFACE_STYLE, { width: side, minHeight: side, padding: CARD_PADDING }];

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={name}
      onPress={onPress}
      onPressIn={pressIn}
      onPressOut={pressOut}
      testID={testID}
      style={pressed ? [...cell, pressedTransform] : cell}
      className={`${CELL} bg-white`}
    >
      <IconTile slug={slug} size="md" testID={testID && `${testID}-tile`} />
      <View
        style={{ minHeight: nameSlotMinHeight(side, fontScale) }}
        className="justify-end"
        testID={testID && `${testID}-name`}
      >
        {/* A word wider than the card (a long one at 1.3 on a narrow phone) breaks at a syllable
            with a hyphen on Android instead of anywhere; iOS has no such switch and its narrowest
            phone leaves the launch names whole. */}
        <Text
          numberOfLines={NAME_MAX_LINES}
          android_hyphenationFrequency="normal"
          className={NAME_TYPE}
        >
          {name}
        </Text>
      </View>
    </Pressable>
  );
}

export type CategoryCardSkeletonProps = {
  /** The same side the cards will get, from the same measured row. */
  side: number;
  testID?: string;
};

/**
 * A card-shaped placeholder: the same cell, a tile-sized square where the icon goes and the same
 * name slot, so the grid keeps its height when the names arrive (up to two lines each, at any
 * font scale). Hidden from assistive technology; the caller labels the loading group once.
 */
export function CategoryCardSkeleton({ side, testID }: CategoryCardSkeletonProps) {
  const pulse = useSkeletonPulse();
  const { fontScale } = useWindowDimensions();

  return (
    <Animated.View style={pulse} testID={testID}>
      <View
        style={[continuousCorners, { width: side, minHeight: side, padding: CARD_PADDING }]}
        className={`${CELL} bg-gray-500/15`}
        testID={testID && `${testID}-shape`}
      >
        <View
          style={[
            continuousCorners,
            { width: TILE.side, height: TILE.side, borderRadius: tokens.radius[TILE.radius] },
          ]}
          className="bg-gray-500/15"
          testID={testID && `${testID}-tile`}
        />
        <View
          style={{ minHeight: nameSlotMinHeight(side, fontScale) }}
          className="justify-end"
          testID={testID && `${testID}-name`}
        >
          <View className="h-3 w-20 rounded-sm bg-gray-500/15" />
        </View>
      </View>
    </Animated.View>
  );
}
