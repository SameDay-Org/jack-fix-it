import type { ReactNode } from "react";
import Svg, { Circle, G, Path, Rect } from "react-native-svg";

import { tokens } from "@/theme";

import type { CardBrand } from "./cards";

/** The mark's box in dp: a small card. It never follows the font scale. */
export const BRAND_MARK = { width: 40, height: 28 } as const;
const CORNER = 6;
const LETTER_STROKE = 1.7;

/** What the mark sits on: `light` is a white tile for a dark surface, `dark` the reverse. */
export type BrandMarkTone = "light" | "dark";

const INKS: Record<BrandMarkTone, { tile: string; ink: string }> = {
  light: { tile: tokens.colors.white, ink: tokens.colors["navy-900"] },
  dark: { tile: tokens.colors["navy-900"], ink: tokens.colors.white },
};
const ACCENT = tokens.colors["green-500"];

/** Letters drawn as strokes, one path per word, in the mark's 40 x 28 box. */
const letters = (d: string, ink: string): ReactNode => (
  <Path
    d={d}
    fill="none"
    stroke={ink}
    strokeWidth={LETTER_STROKE}
    strokeLinecap="round"
    strokeLinejoin="round"
  />
);

/*
 * Flat marks in the app's two inks and its one accent, not the networks' own artwork or colors:
 * enough to tell the cards of a wallet apart at a glance. The brand's name is always written
 * beside the mark, and said by the card's label.
 */
const MARKS: Record<CardBrand, (ink: string) => ReactNode> = {
  // The four letters, leaning forward.
  visa: (ink) => (
    <G transform="translate(3 0) skewX(-12)">
      {letters(
        "M7 9l3 10l3-10M16 9v10M24 10.6c-1-2-4.8-1.9-4.6.8c.2 2.5 4.6 2.2 4.8 5c.2 2.8-4 3.2-5.2 1M26.5 19l3.25-10L33 19M27.7 15.5h4.1",
        ink,
      )}
    </G>
  ),
  // Two discs that overlap.
  mastercard: (ink) => (
    <>
      <Circle cx={15.5} cy={14} r={7} fill={ink} />
      <Circle cx={24.5} cy={14} r={7} fill={ACCENT} opacity={0.9} />
    </>
  ),
  // The short name, in capitals.
  amex: (ink) =>
    letters(
      "M7.3 18l2.5-8l2.5 8M8.3 15.3h3M14.1 18v-8l3 5l3-5v8M25.9 10h-4v8h4M21.9 14h3.1M27.7 10l5 8M32.7 10l-5 8",
      ink,
    ),
  // A word with a ball for its letter o.
  discover: (ink) => (
    <>
      <Path d="M7.5 14h10" stroke={ink} strokeWidth={2.4} strokeLinecap="round" />
      <Circle cx={26.5} cy={14} r={6} fill={ACCENT} />
    </>
  ),
  // Any other card: its stripe and its chip.
  generic: (ink) => (
    <>
      <Path d="M0 8h40v4H0z" fill={ink} />
      <Rect x={7} y={16} width={9} height={5.5} rx={1.5} fill={ACCENT} />
    </>
  ),
};

export type BrandMarkProps = { brand: CardBrand; tone: BrandMarkTone; testID?: string };

/** A card brand's flat mark. Decorative: hidden from screen readers on both platforms. */
export function BrandMark({ brand, tone, testID }: BrandMarkProps) {
  const { tile, ink } = INKS[tone];
  return (
    <Svg
      width={BRAND_MARK.width}
      height={BRAND_MARK.height}
      viewBox={`0 0 ${BRAND_MARK.width} ${BRAND_MARK.height}`}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      testID={testID}
    >
      <Rect width={BRAND_MARK.width} height={BRAND_MARK.height} rx={CORNER} fill={tile} />
      {MARKS[brand](ink)}
    </Svg>
  );
}
