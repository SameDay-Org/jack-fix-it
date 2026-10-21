import { StatusBar, type StatusBarStyle } from "expo-status-bar";
import type { ReactNode } from "react";
import { View } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";

import { cx } from "./cx";

/** What sits under the system status bar: a navy hero (light icons) or the light page (dark icons). */
export type SystemBar = "hero" | "light";

export type ScreenProps = {
  bar: SystemBar;
  children: ReactNode;
  /** Extra classes for the page; the background is gray-50. */
  className?: string;
  testID?: string;
};

// The one owner of the system bar. The root layout mounts no StatusBar, so the focused screen's
// style wins, and the backdrop strip under the bar stays outside any scrolling content: the icons
// keep their contrast while content passes underneath. The strip matches what sits below it, so a
// navy hero reads as one sheet from the very top of the screen.
const BAR: Record<SystemBar, { style: StatusBarStyle; backdrop: string }> = {
  hero: { style: "light", backdrop: "bg-navy-900" },
  light: { style: "dark", backdrop: "bg-gray-50" },
};

export function Screen({ bar, children, className, testID }: ScreenProps) {
  const { top } = useSafeAreaInsets();

  return (
    <SafeAreaView edges={["bottom"]} testID={testID} className={cx("flex-1 bg-gray-50", className)}>
      <StatusBar style={BAR[bar].style} />
      <View testID="system-bar-backdrop" className={BAR[bar].backdrop} style={{ height: top }} />
      {children}
    </SafeAreaView>
  );
}
