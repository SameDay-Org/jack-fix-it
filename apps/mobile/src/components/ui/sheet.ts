import type { Stack } from "expo-router";
import type { ComponentProps } from "react";

import { tokens } from "@/theme";

import { isLiquidGlassCapable } from "./GlassSurface";

type ScreenOptions = Exclude<
  NonNullable<ComponentProps<typeof Stack.Screen>["options"]>,
  (...args: never[]) => unknown
>;

/**
 * Fractions of the screen height the sheet may rest at, or the height of its content. A
 * `"fitToContents"` route renders `<SheetContent fitToContents>`: Android hides a fit-to-contents
 * sheet whose root fills, since the sheet, not the parent, is the source of the size.
 */
export type SheetDetents = "fitToContents" | number[];

/**
 * Screen options for a native form sheet (ADR 0008): the system draws it, with Liquid Glass on
 * iOS 26+ and the same detents on Android. Present a route with these options from its Stack; the
 * route renders `SheetContent`.
 */
export function sheetOptions(detents: SheetDetents): ScreenOptions {
  return {
    presentation: "formSheet",
    sheetAllowedDetents: detents,
    sheetGrabberVisible: true,
    sheetCornerRadius: tokens.radius.xl,
    headerShown: false,
    // Whatever the content does not cover belongs to the system where it draws glass, and is the
    // white surface everywhere else (on iOS a filling root stops at its content with fraction
    // detents, so the surface cannot be left to the route alone).
    contentStyle: {
      backgroundColor: isLiquidGlassCapable() ? "transparent" : tokens.colors.white,
    },
  };
}
