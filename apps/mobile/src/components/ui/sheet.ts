import type { Stack } from "expo-router";
import type { ComponentProps } from "react";

import { tokens } from "@/theme";

type ScreenOptions = Exclude<
  NonNullable<ComponentProps<typeof Stack.Screen>["options"]>,
  (...args: never[]) => unknown
>;

/** Fractions of the screen height the sheet may rest at, or the height of its content. */
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
    // The route paints its own surface only where the system does not (see SheetContent).
    contentStyle: { backgroundColor: "transparent" },
  };
}
