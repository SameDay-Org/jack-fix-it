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

/** A color token at an opacity, as a React Native color string. */
export function withOpacity(token: ColorToken, opacity: number): string {
  const hex = tokens.colors[token];
  const channel = (offset: number) => Number.parseInt(hex.slice(offset, offset + 2), 16);
  return `rgba(${channel(1)}, ${channel(3)}, ${channel(5)}, ${opacity})`;
}

/** What a glass surface floats over: light page content or a dark hero. */
export type GlassTone = keyof typeof tokens.glass;

type GlassTokens = Record<
  GlassTone,
  { tint: ColorToken; tintOpacity: number; fallback: ColorToken; fallbackOpacity: number }
>;

// JSON widens the token names to string; tokens.test.ts checks they name real colors.
const glass = tokens.glass as GlassTokens;

/** Tint for native Liquid Glass (`regular` style), strong enough to keep text on it at AA. */
export const glassTint: Record<GlassTone, string> = {
  light: withOpacity(glass.light.tint, glass.light.tintOpacity),
  dark: withOpacity(glass.dark.tint, glass.dark.tintOpacity),
};

/**
 * The solid surface used when glass is unavailable, unknown or hidden by Reduce Transparency: the
 * light tone is an opaque white bubble lifted by the shadow (text under a control never ghosts
 * through), the dark tone solid navy.
 */
export const glassFallback: Record<GlassTone, ViewStyle> = {
  light: {
    backgroundColor: withOpacity(glass.light.fallback, glass.light.fallbackOpacity),
    ...bubbleShadow,
  },
  dark: { backgroundColor: withOpacity(glass.dark.fallback, glass.dark.fallbackOpacity) },
};
