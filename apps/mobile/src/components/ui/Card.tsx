import type { ReactNode } from "react";
import { Pressable, View } from "react-native";

import { cx } from "./cx";

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

// shadow-sm sets shadow* and elevation together (NativeWind); shadow-navy keeps the color a token.
const SURFACE = "rounded-2xl bg-white p-4 shadow-sm shadow-navy";

export function Card(props: CardProps) {
  const { children, className, testID } = props;

  if (props.onPress) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={props.accessibilityLabel}
        onPress={props.onPress}
        testID={testID}
        className={cx(SURFACE, "active:opacity-80", className)}
      >
        {children}
      </Pressable>
    );
  }

  return (
    <View testID={testID} className={cx(SURFACE, className)}>
      {children}
    </View>
  );
}
