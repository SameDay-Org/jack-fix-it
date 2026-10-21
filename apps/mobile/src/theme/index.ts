import type { ViewStyle } from "react-native";

import tokens from "./tokens.json";

export { tokens };

export type ColorToken = keyof typeof tokens.colors;
export type Radius = keyof typeof tokens.radius;

const { bubble } = tokens.shadow;

/**
 * The bubble shadow from the brief: navy-900 at low opacity, large blur, small y offset. The one
 * recipe for raised surfaces (Card, Input). It is a style, not a class, because NativeWind's shadow
 * utilities fold the opacity into the color, and Android's elevation shadow multiplies that alpha
 * again until nothing shows. iOS draws shadow* and ignores `elevation`; Android does the reverse.
 */
export const bubbleShadow = {
  shadowColor: tokens.colors["navy-900"],
  shadowOffset: { width: 0, height: bubble.offsetY },
  shadowOpacity: bubble.opacity,
  shadowRadius: bubble.blur,
  elevation: bubble.elevation,
} as const satisfies ViewStyle;

/** Radii read as squircles on iOS; Android has no `borderCurve` and ignores it. */
export const continuousCorners = { borderCurve: "continuous" } as const satisfies ViewStyle;

/**
 * A pressed surface shrinks a hair instead of flashing a color. It is a plain style, not a
 * `scale-*` class: NativeWind builds transforms on CSS variables, and a variable that first appears
 * on press makes the component remount mid-press (and crashes the dev warning that reports it).
 */
export const pressedTransform = {
  transform: [{ scale: tokens.motion.pressedScale }],
} as const satisfies ViewStyle;
