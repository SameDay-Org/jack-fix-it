import { StatusBar, type StatusBarStyle } from "expo-status-bar";
import type { ReactNode } from "react";
import { View } from "react-native";
import { SafeAreaView, useSafeAreaInsets, type Edge } from "react-native-safe-area-context";

import { cx } from "./cx";

/** What sits under the system status bar: a navy hero (light icons) or the light page (dark icons). */
export type SystemBar = "hero" | "light";

export type ScreenProps = {
  bar: SystemBar;
  children: ReactNode;
  /** Safe-area edges the screen pads. A screen under a floating bar that pads itself drops "bottom". */
  edges?: Edge[];
  /** Extra classes for the page; the background is gray-50 under a light bar, navy-900 under a hero. */
  className?: string;
  /**
   * Whether this screen sets the status bar style (default true). The most recently mounted
   * StatusBar wins, so a screen that is mounted but not shown (prefetched) passes false.
   */
  ownsStatusBar?: boolean;
  /**
   * The status bar style when it is not the page's own: a screen drawn over another one that still
   * shows at the top (a panel rising into it) mirrors that one's icons until it covers the bar.
   */
  statusBar?: SystemBar;
  testID?: string;
};

// The one owner of the system bar. The root layout mounts no StatusBar, and the most recently
// mounted one wins: the screen on top, as long as screens built ahead of time (prefetched) set
// `ownsStatusBar` false until they are shown. The backdrop strip under the bar stays outside any
// scrolling content: the icons
// keep their contrast while content passes underneath. The strip matches what sits below it, so a
// navy hero reads as one sheet from the very top of the screen.
// The page itself takes the bar's color too: under a hero bar everything is navy from the very
// first layer, so a hero screen that fades over another one (the launch intro into Welcome) never
// shows a lighter page through its content while Android composites the layers separately.
const BAR: Record<SystemBar, { style: StatusBarStyle; backdrop: string; page: string }> = {
  hero: { style: "light", backdrop: "bg-navy-900", page: "bg-navy-900" },
  light: { style: "dark", backdrop: "bg-gray-50", page: "bg-gray-50" },
};

const DEFAULT_EDGES: Edge[] = ["bottom"];

export function Screen({
  bar,
  children,
  edges = DEFAULT_EDGES,
  className,
  ownsStatusBar = true,
  statusBar = bar,
  testID,
}: ScreenProps) {
  const { top } = useSafeAreaInsets();

  return (
    <SafeAreaView edges={edges} testID={testID} className={cx("flex-1", BAR[bar].page, className)}>
      {ownsStatusBar ? <StatusBar style={BAR[statusBar].style} /> : null}
      <View testID="system-bar-backdrop" className={BAR[bar].backdrop} style={{ height: top }} />
      {/* The content area ends above the padded edges, so an absolutely positioned child (a
          floating bar) sits above the bottom inset without reading it. */}
      <View className="flex-1">{children}</View>
    </SafeAreaView>
  );
}
