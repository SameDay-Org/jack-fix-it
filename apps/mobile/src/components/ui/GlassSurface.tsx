import { GlassView, isGlassEffectAPIAvailable, isLiquidGlassAvailable } from "expo-glass-effect";
import { cssInterop } from "nativewind";
import type { ReactNode } from "react";
import { View } from "react-native";

import {
  continuousCorners,
  glassFallback,
  glassTint,
  tokens,
  type GlassTone,
  type Radius,
} from "@/theme";

import { useReduceTransparency, type ReduceTransparency } from "./useReduceTransparency";

export type { GlassTone };
export type GlassShape = Extract<Radius, "pill" | "xl" | "lg">;

export type GlassSurfaceProps = {
  /** What the surface floats over: light page content (dark text on it) or a dark hero (white text). */
  tone: GlassTone;
  shape: GlassShape;
  /** The glass reacts to touch (iOS 26+ only; the fallback is static). */
  interactive?: boolean;
  children: ReactNode;
  /** Layout classes: padding, size, flex, position. Colors and radius are the surface's own. */
  className?: string;
  testID?: string;
};

// Third-party views take `className` only once NativeWind knows them.
cssInterop(GlassView, { className: "style" });

/** Native glass exists here and the system is known not to hide it; unknown means the fallback. */
function canUseGlass(reduceTransparency: ReduceTransparency): boolean {
  return reduceTransparency === false && isLiquidGlassAvailable() && isGlassEffectAPIAvailable();
}

/** Whether this device renders native Liquid Glass right now, for surfaces the system draws. */
export function useLiquidGlass(): boolean {
  return canUseGlass(useReduceTransparency());
}

/**
 * The one way the app renders Liquid Glass (ADR 0008): native glass on iOS 26+ when available and
 * Reduce Transparency is off; otherwise a near-solid token surface with the same shape. For the
 * controls layer only (bars, sheets, floating buttons, toasts), never for content cards.
 */
export function GlassSurface({
  tone,
  shape,
  interactive = false,
  children,
  className,
  testID,
}: GlassSurfaceProps) {
  const reduceTransparency = useReduceTransparency();
  // The radius rides in `style` so both paths carry the same token without a class round-trip. The
  // surface does not clip: on iOS `overflow: hidden` would cut the fallback's shadow, and children
  // of a glass surface are pills and circles that respect the shape on their own.
  const shapeStyle = { borderRadius: tokens.radius[shape], ...continuousCorners };

  if (canUseGlass(reduceTransparency)) {
    return (
      <GlassView
        glassEffectStyle="regular"
        tintColor={glassTint[tone]}
        colorScheme={tone}
        isInteractive={interactive}
        testID={testID}
        style={shapeStyle}
        className={className}
      >
        {children}
      </GlassView>
    );
  }

  return (
    <View testID={testID} style={[glassFallback[tone], shapeStyle]} className={className}>
      {children}
    </View>
  );
}
