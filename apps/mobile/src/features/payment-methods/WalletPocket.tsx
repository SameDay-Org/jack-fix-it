import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ActivityIndicator,
  Pressable,
  Text,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
  type ViewStyle,
} from "react-native";
import Svg, { Circle, Defs, LinearGradient, Path, Rect, Stop } from "react-native-svg";

import { ControlIcon } from "@/components/icons";
import { useFlag } from "@/components/ui";
import { bubbleShadow, continuousCorners, pressedTransform, tokens, withOpacity } from "@/theme";

import { BrandMark } from "./BrandMark";
import { DefaultMark, stackTone, type CardTone } from "./CardFace";
import {
  brandOf,
  cardName,
  expiryOf,
  maskedNumber,
  shortSpokenCard,
  spokenCard,
  walletOrder,
  type SavedCard,
  type Wallet,
} from "./cards";

/** How many cards peek out of the closed pocket; "See all" brings out the rest. */
export const POCKET_CARDS = 3;

/**
 * A card in the pocket, in dp: `peek` is what shows above the card in front of it (a 48 dp
 * target at the smallest font), `tuck` what hides behind it, `inset` how much narrower than the
 * pocket the cards are.
 */
export const STRIP = { peek: 48, tuck: 24, inset: 12 } as const;
/** The pocket's front: its height at the smallest font, and the dip its top edge makes. */
export const POCKET = {
  minHeight: 152,
  notchDepth: 16,
  notchFrom: 0.28,
  notchTo: 0.72,
  stitchInset: 10,
  stitchRadius: 16,
  rivetRadius: 4.5,
  rivetInset: 28,
} as const;
/** How much of the "See all" tab's tucked part stays in view above the wallet's back. */
const WALL_LIP = 8;
const CORNER = tokens.radius.lg;
const TAB_CHEVRON = 16;
const ADD_ICON = 24;

const WHITE = tokens.colors.white;
/** A control that cannot be used right now, as the kit's Button dims one. */
const DIMMED: ViewStyle = { opacity: 0.5 };
const cardTop: ViewStyle = { borderTopLeftRadius: CORNER, borderTopRightRadius: CORNER };

/** The pocket's front as one outline: rounded corners, and a soft dip in the middle of the top. */
function pocketPath(width: number, height: number): string {
  const r = CORNER;
  const from = width * POCKET.notchFrom;
  const to = width * POCKET.notchTo;
  const middle = width / 2;
  const ease = (to - from) / 4;
  const dip = POCKET.notchDepth;
  return [
    `M0 ${r}A${r} ${r} 0 0 1 ${r} 0H${from}`,
    `C${from + ease} 0 ${middle - ease} ${dip} ${middle} ${dip}`,
    `C${middle + ease} ${dip} ${to - ease} 0 ${to} 0H${width - r}`,
    `A${r} ${r} 0 0 1 ${width} ${r}V${height - r}A${r} ${r} 0 0 1 ${width - r} ${height}`,
    `H${r}A${r} ${r} 0 0 1 0 ${height - r}Z`,
  ].join("");
}

type Size = { width: number; height: number };

/**
 * The pocket's front, drawn to its measured size: navy, a sheen fading down from the top edge, a
 * stitched seam and two lime rivets. Decorative. Until the first layout it is a plain navy bubble,
 * so what is written on it is never on nothing.
 */
function PocketFront({ size }: { size: Size | null }) {
  if (!size) {
    return <View className="absolute inset-0 rounded-lg bg-navy-900" style={continuousCorners} />;
  }
  const { width, height } = size;
  const outline = pocketPath(width, height);
  const seamTop = POCKET.notchDepth + POCKET.stitchInset;
  const rivetY = seamTop + POCKET.rivetInset - POCKET.stitchInset;
  return (
    <Svg
      width={width}
      height={height}
      style={{ position: "absolute", left: 0, top: 0 }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      testID="wallet-pocket-front"
    >
      <Defs>
        <LinearGradient id="pocket-sheen" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={WHITE} stopOpacity={0.14} />
          <Stop offset="0.6" stopColor={WHITE} stopOpacity={0} />
        </LinearGradient>
      </Defs>
      <Path d={outline} fill={tokens.colors["navy-900"]} />
      <Path d={outline} fill="url(#pocket-sheen)" />
      <Rect
        x={POCKET.stitchInset}
        y={seamTop}
        width={width - 2 * POCKET.stitchInset}
        height={height - seamTop - POCKET.stitchInset}
        rx={POCKET.stitchRadius}
        fill="none"
        stroke={withOpacity("white", 0.28)}
        strokeWidth={1.5}
        strokeDasharray="5 5"
        strokeLinecap="round"
      />
      <Circle
        cx={POCKET.rivetInset}
        cy={rivetY}
        r={POCKET.rivetRadius}
        fill={tokens.colors["green-500"]}
      />
      <Circle
        cx={width - POCKET.rivetInset}
        cy={rivetY}
        r={POCKET.rivetRadius}
        fill={tokens.colors["green-500"]}
      />
    </Svg>
  );
}

type CardStripProps = {
  card: SavedCard;
  /** Its colors (`stackTone`). */
  tone: CardTone;
  /** The card at the back of the stack: it tucks behind nothing, under the rim of the wallet's back. */
  first: boolean;
  /** With its expiry and its Default mark, as "See all" shows the cards. */
  detailed: boolean;
  onOpen: () => void;
};

/**
 * One card peeking out of the pocket: a button that opens it, read out in full. Its mark, brand
 * and number share a line while the brand fits beside the number; once the brand name would wrap
 * (large text, a narrow phone) the brand takes a line of its own under the mark and the number, so
 * a word is never broken. A wrap counts for the width and font scale it happened at.
 */
function CardStrip({ card, tone, first, detailed, onOpen }: CardStripProps) {
  const { t } = useTranslation();
  const [pressed, pressIn, pressOut] = useFlag();
  const { width, fontScale } = useWindowDimensions();
  const fit = `${width}:${fontScale}`;
  const [wrappedAt, setWrappedAt] = useState<string | null>(null);
  const stacked = wrappedAt === fit;
  const ink = { color: tokens.colors[tone.ink] };
  const brandName = t(`paymentMethods.brand.${brandOf(card)}`);
  const number = (
    <Text className="text-headline" style={ink}>
      {maskedNumber(card)}
    </Text>
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={spokenCard(t, card)}
      accessibilityHint={t("paymentMethods.strip.hint")}
      onPress={onOpen}
      onPressIn={pressIn}
      onPressOut={pressOut}
      style={[
        bubbleShadow,
        continuousCorners,
        cardTop,
        {
          marginTop: first ? 0 : -STRIP.tuck,
          marginHorizontal: STRIP.inset,
          minHeight: STRIP.peek + STRIP.tuck,
          paddingBottom: STRIP.tuck,
          backgroundColor: tokens.colors[tone.surface],
        },
        pressed && pressedTransform,
      ]}
      testID={`wallet-card-${card.id}`}
    >
      <View className="justify-center gap-1 px-4 py-2" style={{ minHeight: STRIP.peek }}>
        {stacked ? (
          <View className="gap-1" testID={`wallet-card-${card.id}-stacked`}>
            <View className="flex-row items-center justify-between gap-3">
              <BrandMark brand={brandOf(card)} tone={tone.mark} />
              {number}
            </View>
            <Text className="text-headline" style={ink}>
              {brandName}
            </Text>
          </View>
        ) : (
          <View className="flex-row items-center gap-3">
            <BrandMark brand={brandOf(card)} tone={tone.mark} />
            <Text
              className="shrink grow text-headline"
              style={ink}
              onTextLayout={(event) => {
                if (event.nativeEvent.lines.length > 1) setWrappedAt(fit);
              }}
              testID={`wallet-card-${card.id}-brand`}
            >
              {brandName}
            </Text>
            {number}
          </View>
        )}
        {detailed ? (
          <View className="flex-row flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <Text className="text-footnote" style={ink}>
              {t("paymentMethods.expires", { expiry: expiryOf(card) })}
            </Text>
            {card.is_default ? (
              <DefaultMark tone={tone} testID={`wallet-card-${card.id}-default`} />
            ) : null}
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

export type WalletPocketProps = {
  /** The wallet as the API lists it (the newest first); the pocket puts the default in front. */
  wallet: Wallet;
  /** Every card out of the pocket, each with its expiry ("See all"). */
  expanded: boolean;
  onToggle: () => void;
  onOpen: (card: SavedCard) => void;
  /** The empty pocket is the Add button. */
  onAdd: () => void;
  adding: boolean;
  /** Another change of the wallet is unanswered: the empty pocket cannot add a card meanwhile. */
  locked: boolean;
  /** A change of the wallet is unanswered, or its list is on its way: who is the default may move. */
  settling: boolean;
  /** The wallet could not be listed again: what it shows may be out of date. */
  stale: boolean;
};

/**
 * The wallet: a navy pocket with the saved cards stacked in it, peeking out one above the other,
 * the default in front. Its face names the default card; an empty one is the Add button. "See
 * all" brings every card out with its expiry; a card opens when tapped.
 */
export function WalletPocket({
  wallet,
  expanded,
  onToggle,
  onOpen,
  onAdd,
  adding,
  locked,
  settling,
  stale,
}: WalletPocketProps) {
  const { t } = useTranslation();
  const cards = useMemo(() => walletOrder(wallet), [wallet]);
  const [front, setFront] = useState<Size | null>(null);
  const [tabHeight, setTabHeight] = useState<number>(STRIP.peek + STRIP.tuck);
  const [tabPressed, tabPressIn, tabPressOut] = useFlag();
  const [addPressed, addPressIn, addPressOut] = useFlag();

  const measureFront = ({ nativeEvent: { layout } }: LayoutChangeEvent) =>
    setFront((size) =>
      size?.width === layout.width && size.height === layout.height
        ? size
        : { width: layout.width, height: layout.height },
    );

  const empty = cards.length === 0;
  const shown = expanded ? cards : cards.slice(0, POCKET_CARDS);
  const defaultCard = cards.find((card) => card.is_default);
  const frontStyle: ViewStyle = { marginTop: empty ? 0 : -STRIP.tuck, minHeight: POCKET.minHeight };
  const faceClass = "flex-1 items-center justify-center gap-1 px-6 pb-7";
  // With no default on the face: a change on its way, a list that could not be fetched again (no
  // claim either way), or a wallet the server says has none.
  const noneFace = settling ? "updating" : stale ? "stale" : "none";
  const facePadding = { paddingTop: POCKET.notchDepth + 28 };

  return (
    <View testID="wallet-pocket">
      {empty ? null : (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          onPress={onToggle}
          onPressIn={tabPressIn}
          onPressOut={tabPressOut}
          onLayout={({ nativeEvent }) => setTabHeight(nativeEvent.layout.height)}
          className="w-2/3 flex-row items-center justify-center gap-1 self-center px-4"
          style={[
            continuousCorners,
            cardTop,
            {
              minHeight: STRIP.peek + STRIP.tuck,
              paddingBottom: STRIP.tuck,
              backgroundColor: withOpacity("navy-900", tabPressed ? 0.1 : 0.05),
            },
          ]}
          testID="wallet-see-all"
        >
          <Text className="text-callout font-semibold text-gray-500">
            {t(expanded ? "paymentMethods.showLess" : "paymentMethods.seeAll")}
          </Text>
          {expanded ? null : (
            <ControlIcon name="chevron" size={TAB_CHEVRON} color={tokens.colors["gray-500"]} />
          )}
        </Pressable>
      )}
      {/* The wallet's back, behind the cards: its rim shows above them, at their sides and through
          the dip. It covers the tab's tucked part (Android orders by elevation before order). */}
      <View
        className="absolute inset-x-0 bottom-0 rounded-lg bg-navy-700"
        style={[
          bubbleShadow,
          continuousCorners,
          { top: empty ? 0 : tabHeight - STRIP.tuck + WALL_LIP },
        ]}
      />
      {/* Back to front, so each card is drawn over the one behind it. One full-width box above the
          pocket's face: Android reads overlapping views by their left edge first, and the strips,
          inset from the pocket's sides, would be read after the face. Its elevation keeps the
          strips over the wallet's back on Android; with no background it casts no shadow. */}
      <View
        collapsable={false}
        style={{ elevation: bubbleShadow.elevation }}
        testID="wallet-strips"
      >
        {[...shown].reverse().map((card, place) => (
          <CardStrip
            key={card.id}
            card={card}
            tone={stackTone(wallet, card)}
            first={place === 0}
            detailed={expanded}
            onOpen={() => onOpen(card)}
          />
        ))}
      </View>
      {empty ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("paymentMethods.pocket.add")}
          accessibilityHint={t("paymentMethods.pocket.addHint")}
          accessibilityState={{ disabled: adding || locked, busy: adding }}
          disabled={adding || locked}
          onPress={onAdd}
          onPressIn={addPressIn}
          onPressOut={addPressOut}
          onLayout={measureFront}
          // Over the wallet's back on Android, which orders by elevation before order.
          style={[
            frontStyle,
            { elevation: bubbleShadow.elevation },
            locked && !adding && DIMMED,
            addPressed && pressedTransform,
          ]}
          testID="wallet-pocket-add"
        >
          <PocketFront size={front} />
          <View className={faceClass} style={facePadding}>
            {adding ? (
              <ActivityIndicator color={WHITE} testID="wallet-pocket-adding" />
            ) : (
              <ControlIcon name="plus" size={ADD_ICON} color={tokens.colors["green-500"]} />
            )}
            <Text className="text-center text-title-2 text-white">
              {t("paymentMethods.pocket.add")}
            </Text>
          </View>
        </Pressable>
      ) : (
        <View
          onLayout={measureFront}
          style={[frontStyle, { elevation: bubbleShadow.elevation }]}
          testID="wallet-pocket-face"
        >
          <PocketFront size={front} />
          {defaultCard ? (
            <View
              accessible
              accessibilityLabel={t("paymentMethods.pocket.defaultSpoken", {
                card: shortSpokenCard(t, defaultCard),
              })}
              className={faceClass}
              style={facePadding}
              testID="wallet-pocket-default"
            >
              <Text className="text-center text-caption font-semibold text-green-500">
                {t("paymentMethods.default")}
              </Text>
              <Text className="text-center text-title-2 text-white">
                {cardName(t, defaultCard)}
              </Text>
            </View>
          ) : (
            <View
              accessible
              className={faceClass}
              style={facePadding}
              testID={`wallet-pocket-${noneFace}`}
            >
              <Text className="text-center text-title-2 text-white">
                {t(`paymentMethods.pocket.${noneFace}`)}
              </Text>
              {noneFace === "none" ? (
                <Text className="text-center text-callout text-white">
                  {t("paymentMethods.pocket.noneHint")}
                </Text>
              ) : null}
            </View>
          )}
        </View>
      )}
    </View>
  );
}
