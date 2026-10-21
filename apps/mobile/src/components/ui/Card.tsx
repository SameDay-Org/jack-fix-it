import type { ReactNode } from "react";
import { Pressable, View } from "react-native";

import { bubbleShadow, continuousCorners } from "@/theme";

import { cx } from "./cx";
import { useFlag } from "./useFlag";

type CardBaseProps = {
  children: ReactNode;
  /** Extra classes (margins, padding overrides). */
  className?: string;
  testID?: string;
};

type PressableCardProps = CardBaseProps & {
  onPress: () => void;
  /** Accessible name of the whole card; required because the card becomes a button. */
  accessibilityLabel: string;
};

type StaticCardProps = CardBaseProps & {
  onPress?: undefined;
  accessibilityLabel?: undefined;
};

export type CardProps = PressableCardProps | StaticCardProps;

// The bubble: white, radius lg, continuous corners, the shared soft shadow, padding on the 4-pt grid.
const SURFACE = "rounded-lg bg-white p-4";
const SURFACE_STYLE = [bubbleShadow, continuousCorners];

export function Card(props: CardProps) {
  const { children, className, testID } = props;
  const [pressed, pressIn, pressOut] = useFlag();

  if (props.onPress) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={props.accessibilityLabel}
        onPress={props.onPress}
        onPressIn={pressIn}
        onPressOut={pressOut}
        testID={testID}
        style={SURFACE_STYLE}
        // A pressed card shrinks a hair instead of flashing a color.
        className={cx(SURFACE, pressed && "scale-pressed", className)}
      >
        {children}
      </Pressable>
    );
  }

  return (
    <View testID={testID} style={SURFACE_STYLE} className={cx(SURFACE, className)}>
      {children}
    </View>
  );
}
