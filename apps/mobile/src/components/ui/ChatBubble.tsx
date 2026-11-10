import type { ReactNode } from "react";
import { View } from "react-native";
import Svg, { Path } from "react-native-svg";

import { bubbleShadow, continuousCorners, tokens } from "@/theme";

import { cx } from "./cx";

export type ChatBubbleSide = "mine" | "theirs";

export type ChatBubbleProps = {
  /** Mine sit on the right in navy; theirs on the left in white, lifted by the bubble shadow. */
  side: ChatBubbleSide;
  /** The last bubble of a run carries the small tail at its bottom corner, as the deck's bubbles do. */
  tail: boolean;
  /** Dims the bubble while its message is still on its way. */
  faded?: boolean;
  children: ReactNode;
  testID?: string;
};

// The tail: a curve flaring out of the bubble's bottom corner, on the 4-pt grid.
const TAIL_WIDTH = 8;
const TAIL_HEIGHT = 12;
const TAIL_RIGHT = `M0 0C0 ${TAIL_HEIGHT / 2} 3 10 ${TAIL_WIDTH} ${TAIL_HEIGHT}H0Z`;
const TAIL_LEFT = `M${TAIL_WIDTH} 0C${TAIL_WIDTH} ${TAIL_HEIGHT / 2} 5 10 0 ${TAIL_HEIGHT}H${TAIL_WIDTH}Z`;
const FADED_OPACITY = 0.6;
const SQUARE_RIGHT = { borderBottomRightRadius: 0 } as const;
const SQUARE_LEFT = { borderBottomLeftRadius: 0 } as const;

const SIDE: Record<ChatBubbleSide, { fill: string; color: string }> = {
  mine: { fill: "bg-navy-900", color: tokens.colors["navy-900"] },
  theirs: { fill: "bg-white", color: tokens.colors.white },
};

/**
 * A chat message's surface: a white bubble (theirs) or a navy one (mine) with large continuous
 * corners. The newest bubble of a run squares its bottom corner on the speaker's side and grows
 * the deck's small tail there; the others keep every corner round. Text styles are the caller's.
 */
export function ChatBubble({ side, tail, faded = false, children, testID }: ChatBubbleProps) {
  const mine = side === "mine";
  const { fill, color } = SIDE[side];
  return (
    // Faded as one layer (Android otherwise fades the bubble and its text separately, and the
    // navy shows through the text).
    <View
      style={faded ? { opacity: FADED_OPACITY } : undefined}
      needsOffscreenAlphaCompositing={faded}
      testID={testID}
    >
      <View
        className={cx("rounded-lg px-4 py-2.5", fill)}
        // The squared corner is a style: a class that changes after mount (the tail moving to a
        // newer bubble) can remount the view under NativeWind.
        style={[
          continuousCorners,
          mine ? undefined : bubbleShadow,
          tail ? (mine ? SQUARE_RIGHT : SQUARE_LEFT) : undefined,
        ]}
      >
        {children}
      </View>
      {tail ? (
        <Svg
          width={TAIL_WIDTH}
          height={TAIL_HEIGHT}
          viewBox={`0 0 ${TAIL_WIDTH} ${TAIL_HEIGHT}`}
          style={{
            position: "absolute",
            bottom: 0,
            ...(mine ? { right: -TAIL_WIDTH } : { left: -TAIL_WIDTH }),
          }}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          testID={testID ? `${testID}-tail` : undefined}
        >
          <Path d={mine ? TAIL_RIGHT : TAIL_LEFT} fill={color} />
        </Svg>
      ) : null}
    </View>
  );
}
