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
