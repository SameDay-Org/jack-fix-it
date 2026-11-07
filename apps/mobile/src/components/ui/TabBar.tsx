import { BottomTabBarHeightCallbackContext, BottomTabBarHeightContext } from "expo-router/js-tabs";
import { createContext, useContext, useLayoutEffect, type ReactNode } from "react";
import { Platform, Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import Animated, { useAnimatedStyle, type SharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { TabIcon, type TabGlyphName } from "@/components/icons";
import { bubbleShadow, pressedTransform, tokens, withOpacity } from "@/theme";

import { cx } from "./cx";
import { GlassSurface } from "./GlassSurface";
import { useFlag } from "./useFlag";

export type TabBarItem = {
  key: string;
  /** The visible label, also the tab's accessible name. */
  label: string;
  glyph: TabGlyphName;
  selected: boolean;
  onPress: () => void;
  onLongPress?: () => void;
  testID?: string;
};

export type TabBarProps = {
  /** The tabs, left to right. */
  items: readonly TabBarItem[];
  /**
   * How far the bar has slid down out of sight, on the UI thread: 0 in place, 1 below the
   * screen's bottom edge (a panel rising over the tabs takes the whole screen).
   */
  slideOut?: SharedValue<number>;
  /** Out of sight or on its way: the bar takes no taps and screen readers skip it. */
  hidden?: boolean;
  /**
   * A one-line control floating just above the tabs (an ongoing job), drawn while
   * `TabBarAccessoryContext` says one is shown: the context also grows `useTabBarInset`, so the
   * screens under the bar keep their last row clear of it. It fills a pill of the height
   * `tabBarGeometry` gives it.
   */
  accessory?: ReactNode;
  testID?: string;
};

/**
 * Whether the tab bar shows its accessory. Provided by the tab layout around the navigator, so
 * the bar and every tab root's `useTabBarInset` read the same answer on the same render.
 */
export const TabBarAccessoryContext = createContext(false);

// The bar's geometry on the 4-pt grid. The glyph never scales; the label does, so the bar's height
// follows the font scale and the label keeps one line at every scale (the tab is 48 dp at least).
const ICON_SIZE = 24;
const ICON_LABEL_GAP = 4;
const ITEM_PADDING_Y = 6;
const MIN_TARGET = 48;
// The floating pill: its side inset, its least distance from the screen's bottom edge, and the
// gap it keeps from the home indicator and from the content it floats over.
const FLOAT_MARGIN = 16;
const FLOAT_GAP = 8;
const LABEL_LINE_HEIGHT = tokens.fontSize.caption.lineHeight;
// The accessory: one line of callout text with this padding above and below, 48 dp at least.
const ACCESSORY_LINE_HEIGHT = tokens.fontSize.callout.lineHeight;
const ACCESSORY_PADDING_Y = 12;
const RIPPLE_OPACITY = 0.1;
const HAIRLINE_OPACITY = 0.1;

export type TabBarGeometry = {
  /** The height of the row of tabs, before any inset the bar pads itself. */
  barHeight: number;
  /** Distance from the window's bottom edge to the bar's own bottom edge. */
  bottom: number;
  /** What a tab root keeps free at its bottom edge, so its last row clears the bar. */
  inset: number;
  /** The accessory's height, and its bottom edge's distance from the window's (0 without one). */
  accessoryHeight: number;
  accessoryBottom: number;
};

/** The bar floats as a pill on iOS (the system's own tab bar shape) and docks on Android. */
const floats = () => Platform.OS === "ios";

/**
 * The bar's geometry for a font scale and a bottom safe-area inset: the same numbers size the bar
 * and pad the screens under it, so the content and the bar agree from the first frame and nothing
 * jumps when the bar lays out.
 */
export function tabBarGeometry(
  fontScale: number,
  bottomInset: number,
  floating: boolean,
  accessory = false,
): TabBarGeometry {
  const label = Math.ceil(LABEL_LINE_HEIGHT * fontScale);
  const barHeight = Math.max(MIN_TARGET, ICON_SIZE + ICON_LABEL_GAP + label + 2 * ITEM_PADDING_Y);
  const bottom = floating ? Math.max(bottomInset + FLOAT_GAP, FLOAT_MARGIN) : 0;
  // The top of the tabs, from the window's bottom edge: the docked bar pads the inset itself.
  const top = floating ? bottom + barHeight : bottomInset + barHeight;
  const base = floating ? top + FLOAT_GAP : top;
  if (!accessory) return { barHeight, bottom, inset: base, accessoryHeight: 0, accessoryBottom: 0 };
  const accessoryHeight = Math.max(
    MIN_TARGET,
    Math.ceil(ACCESSORY_LINE_HEIGHT * fontScale) + 2 * ACCESSORY_PADDING_Y,
  );
  const accessoryBottom = top + FLOAT_GAP;
  return {
    barHeight,
    bottom,
    inset: accessoryBottom + accessoryHeight + FLOAT_GAP,
    accessoryHeight,
    accessoryBottom,
  };
}

function useGeometry(): [TabBarGeometry, number] {
  const { fontScale } = useWindowDimensions();
  const { bottom } = useSafeAreaInsets();
  const accessory = useContext(TabBarAccessoryContext);
  return [tabBarGeometry(fontScale, bottom, floats(), accessory), bottom];
}

/**
 * The bottom padding a screen keeps so its last row stays reachable: the tab bar's footprint
 * when the screen is a tab root (the bar floats over the content), the bottom safe-area inset
 * anywhere else. A screen under the bar drops the `Screen` bottom edge and pads with this.
 */
export function useTabBarInset(): number {
  const [geometry, bottom] = useGeometry();
  const underTabBar = useContext(BottomTabBarHeightContext) !== undefined;
  return underTabBar ? geometry.inset : bottom;
}

/**
 * The app's one tab bar (D18): three tabs with a flat glyph and a one-line label each, the
 * selected one in navy-900 with the glyph's green-500 accent, the others in gray-500. On iOS it
 * is a floating pill on the controls layer (Liquid Glass where the device draws it, the kit's
 * solid bubble otherwise); on Android a white bubble docked at the bottom with a top hairline,
 * padding the gesture bar itself. It is absolutely positioned over the screens, which pad it
 * with `useTabBarInset`.
 */
export function TabBar({ items, slideOut, hidden = false, accessory, testID }: TabBarProps) {
  const [geometry, bottom] = useGeometry();
  const reportHeight = useContext(BottomTabBarHeightCallbackContext);
  // Its whole footprint and the gap its shadow spreads into: nothing of it is left on screen.
  const slideDistance = geometry.inset + FLOAT_GAP;
  const slideStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: (slideOut ? slideOut.value : 0) * slideDistance }],
  }));
  const hiding = hidden
    ? ({
        importantForAccessibility: "no-hide-descendants",
        accessibilityElementsHidden: true,
      } as const)
    : {};

  // The navigator's own notion of the bar's height (`useBottomTabBarHeight`) follows the same
  // number the screens pad with.
  useLayoutEffect(() => {
    reportHeight?.(geometry.inset);
  }, [geometry.inset, reportHeight]);

  const row = (
    <View
      accessibilityRole="tablist"
      className="flex-row"
      style={{ height: geometry.barHeight }}
      testID={testID ? `${testID}-tabs` : undefined}
    >
      {items.map((item) => (
        <TabBarButton key={item.key} item={item} />
      ))}
    </View>
  );

  // Above the tabs, sliding with them; a sibling, so the bar's own surface stays as it is.
  const accessoryView =
    geometry.accessoryHeight > 0 && accessory ? (
      <Animated.View
        pointerEvents={hidden ? "none" : "box-none"}
        style={[
          styles.accessory,
          { bottom: geometry.accessoryBottom, height: geometry.accessoryHeight },
          slideStyle,
        ]}
        {...hiding}
        testID={testID ? `${testID}-accessory` : undefined}
      >
        {accessory}
      </Animated.View>
    ) : null;

  if (floats()) {
    return (
      <>
        {accessoryView}
        <Animated.View
          pointerEvents={hidden ? "none" : "box-none"}
          style={[styles.floating, { bottom: geometry.bottom }, slideStyle]}
          {...hiding}
          testID={testID}
        >
          <GlassSurface
            tone="light"
            shape="pill"
            interactive
            testID={testID ? `${testID}-surface` : undefined}
          >
            {row}
          </GlassSurface>
        </Animated.View>
      </>
    );
  }

  return (
    <>
      {accessoryView}
      <Animated.View
        pointerEvents={hidden ? "none" : "auto"}
        className="bg-white"
        style={[styles.docked, bubbleShadow, { paddingBottom: bottom }, slideStyle]}
        {...hiding}
        testID={testID}
      >
        {row}
      </Animated.View>
    </>
  );
}

const RIPPLE = { color: withOpacity("navy-900", RIPPLE_OPACITY) };

function TabBarButton({ item }: { item: TabBarItem }) {
  const { label, glyph, selected, onPress, onLongPress, testID } = item;
  const [pressed, pressIn, pressOut] = useFlag();
  const color = selected ? tokens.colors["navy-900"] : tokens.colors["gray-500"];

  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected }}
      accessibilityLabel={label}
      onPress={onPress}
      onLongPress={onLongPress}
      onPressIn={pressIn}
      onPressOut={pressOut}
      android_ripple={RIPPLE}
      // A style, not a `scale-*` class: a transform class that appears on press remounts the view.
      style={pressed ? pressedTransform : undefined}
      className="min-h-12 flex-1 items-center justify-center"
      testID={testID}
    >
      <TabIcon name={glyph} size={ICON_SIZE} color={color} accent={selected} />
      <Text
        numberOfLines={1}
        style={{ marginTop: ICON_LABEL_GAP }}
        className={cx("text-caption", selected ? "text-navy-900" : "text-gray-500")}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  floating: {
    position: "absolute",
    left: FLOAT_MARGIN,
    right: FLOAT_MARGIN,
  },
  accessory: {
    position: "absolute",
    left: FLOAT_MARGIN,
    right: FLOAT_MARGIN,
  },
  docked: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: withOpacity("navy-900", HAIRLINE_OPACITY),
  },
});
