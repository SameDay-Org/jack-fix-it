import { fireEvent, render, renderHook, screen } from "@testing-library/react-native";
import { BottomTabBarHeightContext } from "expo-router/js-tabs";
import { createElement, type ReactNode } from "react";
import { Dimensions, Platform, StyleSheet, Text } from "react-native";
import { makeMutable } from "react-native-reanimated";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { glassFallback, tokens } from "@/theme";

import {
  tabBarGeometry,
  TabBar,
  TabBarAccessoryContext,
  useTabBarInset,
  type TabBarItem,
} from "../TabBar";

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

const NO_ACCESSORY = { accessoryHeight: 0, accessoryBottom: 0 };

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
      ...NO_ACCESSORY,
    });
  });

  it("floating: 8 dp over the home indicator (16 dp at least), and a gap above the pill", () => {
    expect(tabBarGeometry(1, 34, true)).toEqual({
      barHeight: 56,
      bottom: 42,
      inset: 42 + 56 + 8,
      ...NO_ACCESSORY,
    });
    expect(tabBarGeometry(1, 0, true)).toEqual({
      barHeight: 56,
      bottom: 16,
      inset: 16 + 56 + 8,
      ...NO_ACCESSORY,
    });
  });

  it("an accessory floats 8 dp over the tabs, one callout line tall (48 dp at least), and the inset clears it", () => {
    // Docked: the tabs' top is the inset plus the row; the accessory 8 dp above, then 8 dp of air.
    expect(tabBarGeometry(1, BOTTOM_INSET, false, true)).toEqual({
      barHeight: 56,
      bottom: 0,
      accessoryHeight: 48,
      accessoryBottom: BOTTOM_INSET + 56 + 8,
      inset: BOTTOM_INSET + 56 + 8 + 48 + 8,
    });
    // Floating: over the pill, which already floats 8 dp over the home indicator.
    expect(tabBarGeometry(1, 34, true, true)).toEqual({
      barHeight: 56,
      bottom: 42,
      accessoryHeight: 48,
      accessoryBottom: 42 + 56 + 8,
      inset: 42 + 56 + 8 + 48 + 8,
    });
    // The line grows with the font scale: 20 dp x 2 + 12 dp above and below.
    expect(tabBarGeometry(2, 0, false, true).accessoryHeight).toBe(64);
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

  it("slides below the screen's edge as a panel rises over the tabs, out of reach meanwhile", async () => {
    jest.replaceProperty(Platform, "OS", "android");
    const slideOut = makeMutable(0);
    const bar = () => screen.getByTestId("tab-bar", { includeHiddenElements: true });
    const translateY = () =>
      (bar().props.jestAnimatedStyle as { value: { transform: { translateY: number }[] } }).value
        .transform[0].translateY;
    const ui = (hidden: boolean) => (
      <TabBar items={items} slideOut={slideOut} hidden={hidden} testID="tab-bar" />
    );
    const { rerender } = await render(ui(false), { wrapper });
    expect(translateY()).toBe(0);
    expect(bar().props.pointerEvents).toBe("auto");

    slideOut.value = 1;
    await rerender(ui(true));

    // Its whole footprint and the gap its shadow spreads into.
    expect(translateY()).toBe(tabBarGeometry(fontScale, BOTTOM_INSET, false).inset + 8);
    expect(bar().props.pointerEvents).toBe("none");
    expect(bar().props.accessibilityElementsHidden).toBe(true);
    expect(screen.queryByRole("tab", { name: "Home" })).toBeNull();
  });
});

describe("TabBar accessory", () => {
  const withAccessory = (shown: boolean) =>
    function AccessoryWrapper({ children }: { children: ReactNode }) {
      return createElement(
        TabBarAccessoryContext.Provider,
        { value: shown },
        createElement(wrapper, null, children),
      );
    };
  const accessory = <Text testID="accessory-content">Dan is on the way</Text>;

  it.each(["android", "ios"] as const)(
    "draws the accessory over the tabs while the context says one shows (%s)",
    async (os) => {
      jest.replaceProperty(Platform, "OS", os);
      await render(<TabBar items={items} accessory={accessory} testID="tab-bar" />, {
        wrapper: withAccessory(true),
      });

      const geometry = tabBarGeometry(fontScale, BOTTOM_INSET, os === "ios", true);
      expect(StyleSheet.flatten(screen.getByTestId("tab-bar-accessory").props.style)).toMatchObject(
        {
          position: "absolute",
          left: 16,
          right: 16,
          bottom: geometry.accessoryBottom,
          height: geometry.accessoryHeight,
        },
      );
      expect(screen.getByTestId("accessory-content")).toBeTruthy();
    },
  );

  it("draws nothing without the context, so the screens never pad for a missing accessory", async () => {
    await render(<TabBar items={items} accessory={accessory} testID="tab-bar" />, {
      wrapper: withAccessory(false),
    });

    expect(screen.queryByTestId("tab-bar-accessory")).toBeNull();
    expect(screen.queryByTestId("accessory-content")).toBeNull();
  });

  it("hides with the bar: no taps, and screen readers skip it", async () => {
    await render(<TabBar items={items} accessory={accessory} hidden testID="tab-bar" />, {
      wrapper: withAccessory(true),
    });

    const slot = screen.getByTestId("tab-bar-accessory", { includeHiddenElements: true });
    expect(slot.props.pointerEvents).toBe("none");
    expect(slot.props.accessibilityElementsHidden).toBe(true);
    expect(screen.queryByTestId("accessory-content")).toBeNull();
  });

  it("grows a tab root's inset by the accessory's footprint", async () => {
    jest.replaceProperty(Platform, "OS", "android");
    const underTabs = ({ children }: { children: ReactNode }) =>
      createElement(
        BottomTabBarHeightContext.Provider,
        { value: 0 },
        createElement(withAccessory(true), null, children),
      );
    const { result } = await renderHook(() => useTabBarInset(), { wrapper: underTabs });

    expect(result.current).toBe(tabBarGeometry(fontScale, BOTTOM_INSET, false, true).inset);
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
