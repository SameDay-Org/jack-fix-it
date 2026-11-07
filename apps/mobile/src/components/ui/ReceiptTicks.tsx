import { useWindowDimensions } from "react-native";
import Svg, { Circle, Path } from "react-native-svg";

import { withOpacity } from "@/theme";

import { GLYPH_STROKE_WIDTH, GLYPH_VIEW_BOX } from "../icons/glyphs";

/** Where one of my messages is: still on its way, stored, fetched by the other side, read by them. */
export type ReceiptState = "sending" | "sent" | "delivered" | "seen";

export type ReceiptTicksProps = {
  state: ReceiptState;
  testID?: string;
};

// Drawn on the icon grid (24 units, round caps), on the navy bubble of my own messages; 16 dp at
// the default text size.
const SIZE = 16;
const MUTED_OPACITY = 0.7;
// Muted marks on navy are white at reduced opacity (gray-500 is forbidden on navy).
const MUTED = withOpacity("white", MUTED_OPACITY);
/**
 * The kit's light blue for "seen": a graphic on the navy bubble of my own messages, 9:1 against
 * navy-900 (the WCAG non-text bar is 3:1; ReceiptTicks.test.ts checks it). Kept here rather than in
 * tokens.json until the web theme mirrors it (its parity test reads every mobile color token).
 */
export const RECEIPT_SEEN = "#7CC6FF";

const ONE_TICK = ["M5 12.5l4.5 4.5 9.5-10"];
// The second tick sits to the right; its short stroke tucks under the first tick's long one.
const TWO_TICKS = ["M2 12.5l4.5 4.5 9.5-10", "M11.5 16l1 1 9.5-10"];
const CLOCK_HANDS = "M12 8v4.5l3 1.75";
const CLOCK_RADIUS = 7.5;
const CENTER = GLYPH_VIEW_BOX / 2;

/**
 * The receipt at the bottom right of my own bubble, next to its time: a small clock while the
 * message is on its way, one tick once the server stored it, two once the other side's app
 * fetched it, two in light blue once they read it. Our own flat strokes. Decorative: the bubble's
 * label says the state in words.
 */
export function ReceiptTicks({ state, testID }: ReceiptTicksProps) {
  // Grows with the text size, so the mark keeps its weight beside the time at any scale.
  const size = Math.round(SIZE * useWindowDimensions().fontScale);
  const color = state === "seen" ? RECEIPT_SEEN : MUTED;
  const paths = state === "sent" ? ONE_TICK : TWO_TICKS;
  return (
    <Svg
      width={size}
      height={size}
      viewBox={`0 0 ${GLYPH_VIEW_BOX} ${GLYPH_VIEW_BOX}`}
      fill="none"
      stroke={color}
      strokeWidth={GLYPH_STROKE_WIDTH}
      strokeLinecap="round"
      strokeLinejoin="round"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      testID={testID}
    >
      {state === "sending" ? (
        <>
          <Circle
            cx={CENTER}
            cy={CENTER}
            r={CLOCK_RADIUS}
            testID={testID ? `${testID}-clock` : undefined}
          />
          <Path d={CLOCK_HANDS} />
        </>
      ) : (
        paths.map((d) => <Path key={d} d={d} testID={testID ? `${testID}-tick` : undefined} />)
      )}
    </Svg>
  );
}
