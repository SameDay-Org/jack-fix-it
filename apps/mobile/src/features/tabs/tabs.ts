import type { TabGlyphName } from "@/components/icons";

/** A tab root's route name inside `(app)/(tabs)`. */
export type TabRoute = "index" | "history" | "account";

export type Tab = {
  route: TabRoute;
  glyph: TabGlyphName;
  labelKey: "tabs.home" | "tabs.history" | "tabs.account";
  testID: string;
};

/** The three tabs, left to right (D18): Home, History, Account, for every signed-in role. */
export const TABS: readonly Tab[] = [
  { route: "index", glyph: "home", labelKey: "tabs.home", testID: "tab-home" },
  { route: "history", glyph: "history", labelKey: "tabs.history", testID: "tab-history" },
  { route: "account", glyph: "account", labelKey: "tabs.account", testID: "tab-account" },
];

/** The tab for a route name; `undefined` for a route the bar does not show. */
export function tabFor(route: string): Tab | undefined {
  return TABS.find((tab) => tab.route === route);
}
