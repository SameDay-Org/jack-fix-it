import { useWindowDimensions, View } from "react-native";
import Svg, { Path } from "react-native-svg";

import { VERIFIED_SEAL_PATH, VERIFIED_SEAL_VIEW_BOX } from "@/components/icons";
import { tokens } from "@/theme";

type TypeStyle = keyof typeof tokens.fontSize;

export type VerifiedBadgeProps = {
  /** The type style of the name it follows: the seal is that font size tall, times the font scale. */
  type: TypeStyle;
  testID?: string;
};

/** The space between the name's last letter and the seal. */
const GAP = 4;
// An inline view sits on the line's baseline on both platforms. Dropping the seal by 18% of its
// size centers it on the capitals (cap height is about 0.7 em in Roboto and SF Pro): measured on
// Android at 17 and 28 dp, within half a pixel of their center.
const CAP_CENTER_DROP = 0.18;
// U+2060 WORD JOINER, invisible: no line break between the name and the seal, so a wrapping name
// takes its last word along and the seal never starts a line on its own.
const WORD_JOINER = "\u2060";

/** The seal's side in dp: the name's font size times the font scale, in whole dp. */
export function verifiedBadgeSize(type: TypeStyle, fontScale: number): number {
  return Math.round(tokens.fontSize[type].size * fontScale);
}

/**
 * The verified seal, inline after a pro's name: render it as the last child of the `Text` that
 * holds the name, so it wraps with the name's last word. Green-700 clears 3:1 on white, gray-50 and
 * navy-900 (tokens.test.ts), and the check is a hole, so the surface shows through it.
 *
 * The seal is hidden from screen readers: the text around it says "verified" (a card's summary,
 * or the name's own `accessibilityLabel`), never the seal.
 */
export function VerifiedBadge({ type, testID }: VerifiedBadgeProps) {
  const { fontScale } = useWindowDimensions();
  const size = verifiedBadgeSize(type, fontScale);

  return (
    <>
      {WORD_JOINER}
      <View
        testID={testID}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{ width: GAP + size, height: size, paddingStart: GAP }}
      >
        <Svg
          width={size}
          height={size}
          viewBox={`0 0 ${VERIFIED_SEAL_VIEW_BOX} ${VERIFIED_SEAL_VIEW_BOX}`}
          style={{ transform: [{ translateY: size * CAP_CENTER_DROP }] }}
        >
          <Path d={VERIFIED_SEAL_PATH} fill={tokens.colors["green-700"]} fillRule="evenodd" />
        </Svg>
      </View>
    </>
  );
}
