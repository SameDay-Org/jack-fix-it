import { fireEvent, render, renderHook, screen } from "@testing-library/react-native";
import { BottomTabBarHeightContext } from "expo-router/js-tabs";
import { createElement, type ReactNode } from "react";
import { Dimensions, Platform, StyleSheet } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { glassFallback, tokens } from "@/theme";

import { tabBarGeometry, TabBar, useTabBarInset, type TabBarItem } from "../TabBar";

jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);
// No native glass here: the pill takes the kit's solid fallback surface.
jest.mock("expo-glass-effect", () => ({
  GlassView: () => null,
  isLiquidGlassAvailable: () => false,
  isGlassEffectAPIAvailable: () => false,
}));

const BOTTOM_INSET = 16;
// Jest's window reports a font scale of 2: the bar's row follows it.
const { fontScale } = Dimensions.get("window");
const METRICS = {
  frame: { x: 0, y: 0, width: 320, height: 640 },
  insets: { top: 24, right: 0, bottom: BOTTOM_INSET, left: 0 },
};

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(SafeAreaProvider, { initialMetrics: METRICS }, children);

const onPress = { home: jest.fn(), history: jest.fn(), account: jest.fn() };
const items: TabBarItem[] = [
  {
    key: "a",
    label: "Home",
    glyph: "home",
    selected: true,
    onPress: onPress.home,
    testID: "tab-home",
  },
  {
    key: "b",
    label: "History",
    glyph: "history",
    selected: false,
    onPress: onPress.history,
    testID: "tab-history",
  },
  {
    key: "c",
    label: "Account",
    glyph: "account",
    selected: false,
    onPress: onPress.account,
    testID: "tab-account",
  },
];

const renderBar = () => render(<TabBar items={items} testID="tab-bar" />, { wrapper });

beforeEach(() => jest.clearAllMocks());
afterEach(() => jest.restoreAllMocks());

describe("tabBarGeometry", () => {
  it("a 56 dp row at scale 1.0 that grows with the label at 1.3, never under 48", () => {
    expect(tabBarGeometry(1, 0, false).barHeight).toBe(56);
    expect(tabBarGeometry(1.3, 0, false).barHeight).toBe(61);
    expect(tabBarGeometry(0.5, 0, false).barHeight).toBe(48);
  });

  it("docked: sits on the bottom edge, pads the inset, and the screens keep bar plus inset free", () => {
    expect(tabBarGeometry(1, BOTTOM_INSET, false)).toEqual({
      barHeight: 56,
      bottom: 0,
      inset: BOTTOM_INSET + 56,
    });
  });

  it("floating: 8 dp over the home indicator (16 dp at least), and a gap above the pill", () => {
    expect(tabBarGeometry(1, 34, true)).toEqual({ barHeight: 56, bottom: 42, inset: 42 + 56 + 8 });
    expect(tabBarGeometry(1, 0, true)).toEqual({ barHeight: 56, bottom: 16, inset: 16 + 56 + 8 });
  });
});

describe("TabBar", () => {
  it("renders the items as tabs, in order, with their labels and selected state", async () => {
    await renderBar();

    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.props.accessibilityLabel)).toEqual(["Home", "History", "Account"]);
    expect(tabs.map((tab) => tab.props.accessibilityState.selected)).toEqual([true, false, false]);
    expect(screen.getByTestId("tab-bar-tabs").props.accessibilityRole).toBe("tablist");
    expect(screen.getByText("History").props.numberOfLines).toBe(1);
  });

  it("each tab is a 48 dp target at least and presses through", async () => {
    await renderBar();

    for (const tab of screen.getAllByRole("tab")) {
      expect(tab.props.className).toContain("min-h-12");
      expect(tab.props.className).toContain("flex-1");
    }
    await fireEvent.press(screen.getByTestId("tab-history"));
    expect(onPress.history).toHaveBeenCalledTimes(1);
    expect(onPress.home).not.toHaveBeenCalled();
  });

  it("the selected tab is navy-900 with the accent, the others gray-500", async () => {
    await renderBar();

    expect(screen.getByText("Home").props.className).toContain("text-navy-900");
    expect(screen.getByText("History").props.className).toContain("text-gray-500");
    const accents = screen
      .getByTestId("tab-bar-tabs")
      .queryAll((node) => node.type === "RNSVGPath" && node.props.stroke == null);
    expect(accents).toHaveLength(1);
  });

  it("Android: a white bubble docked at the bottom with a top hairline, padding the inset", async () => {
    jest.replaceProperty(Platform, "OS", "android");
    await renderBar();

    const bar = screen.getByTestId("tab-bar");
    expect(bar.props.className).toContain("bg-white");
    expect(StyleSheet.flatten(bar.props.style)).toMatchObject({
      position: "absolute",
      bottom: 0,
      paddingBottom: BOTTOM_INSET,
      borderTopWidth: StyleSheet.hairlineWidth,
      elevation: tokens.shadow.bubble.elevation,
    });
    expect(StyleSheet.flatten(screen.getByTestId("tab-bar-tabs").props.style).height).toBe(
      tabBarGeometry(fontScale, BOTTOM_INSET, false).barHeight,
    );
  });

  it("iOS: a floating pill on the kit's glass surface, 8 dp over the home indicator", async () => {
    jest.replaceProperty(Platform, "OS", "ios");
    await renderBar();

    const bar = screen.getByTestId("tab-bar");
    expect(StyleSheet.flatten(bar.props.style)).toMatchObject({
      position: "absolute",
      left: 16,
      right: 16,
      bottom: BOTTOM_INSET + 8,
    });
    const surface = screen.getByTestId("tab-bar-surface");
    expect(StyleSheet.flatten(surface.props.style)).toMatchObject({
      ...glassFallback.light,
      borderRadius: tokens.radius.pill,
    });
  });
});

describe("useTabBarInset", () => {
  it("outside a tab navigator it is the bottom safe-area inset", async () => {
    const { result } = await renderHook(() => useTabBarInset(), { wrapper });

    expect(result.current).toBe(BOTTOM_INSET);
  });

  it.each(["android", "ios"] as const)(
    "under a tab navigator it is the bar's footprint for the platform (%s)",
    async (os) => {
      jest.replaceProperty(Platform, "OS", os);
      const underTabs = ({ children }: { children: ReactNode }) =>
        createElement(
          BottomTabBarHeightContext.Provider,
          { value: 0 },
          createElement(wrapper, null, children),
        );
      const { result } = await renderHook(() => useTabBarInset(), { wrapper: underTabs });

      expect(result.current).toBe(tabBarGeometry(fontScale, BOTTOM_INSET, os === "ios").inset);
    },
  );
});
