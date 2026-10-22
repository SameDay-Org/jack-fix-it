import "@/i18n";

import { act, fireEvent, screen } from "@testing-library/react-native";
import { router, useFocusEffect, useLocalSearchParams, useNavigation } from "expo-router";
import { BackHandler } from "react-native";
import { useReducedMotion } from "react-native-reanimated";

import { moveAccessibilityFocus } from "@/components/ui";
import { tokens } from "@/theme";

import { panelHandoffStore } from "../panelHandoff";
import { RoleScreen } from "../RoleScreen";
import { renderInSafeArea } from "./helpers";

jest.mock("expo-router", () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true) },
  useLocalSearchParams: jest.fn(() => ({})),
  // The focus effect (hardware back while focused) runs only where a test calls it.
  useFocusEffect: jest.fn(),
  // The stack's events: `transitionStart` tells the content its screen is being shown.
  useNavigation: jest.fn(() => ({ addListener: jest.fn(() => jest.fn()) })),
}));
jest.mock("@/components/ui", () => ({
  ...jest.requireActual("@/components/ui"),
  moveAccessibilityFocus: jest.fn(),
}));
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));
jest.mock("react-native-reanimated", () => {
  const actual =
    jest.requireActual<typeof import("react-native-reanimated")>("react-native-reanimated");
  return { __esModule: true, ...actual, useReducedMotion: jest.fn(() => false) };
});
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);

const customer = () => screen.getByRole("radio", { name: "I need help at home" });
const pro = () => screen.getByRole("radio", { name: "I'm a pro" });
const next = () => screen.getByRole("button", { name: "Continue" });

const LAYOUT = { nativeEvent: { layout: { x: 0, y: 0, width: 320, height: 600 } } };
type Animated = { opacity?: number; transform?: { translateY: number }[] };
const animated = (testID: string): Animated =>
  (screen.getByTestId(testID).props.jestAnimatedStyle as { value: Animated }).value;
const rootOpacity = () => animated("role-root").opacity;
const slide = () => animated("role-content").transform?.[0].translateY;
const backdrop = () => screen.getByTestId("system-bar-backdrop").props.className as string;

/** Runs the focus effect Role registered, as the navigator does on focus; returns its blur. */
const focus = () => {
  const [effect] = jest.mocked(useFocusEffect).mock.calls.at(-1) as [() => (() => void) | void];
  return effect();
};

describe("RoleScreen", () => {
  beforeEach(() => {
    jest.mocked(router.push).mockClear();
    jest.mocked(router.back).mockClear();
    jest.mocked(useLocalSearchParams).mockReturnValue({});
    jest.mocked(useReducedMotion).mockReturnValue(false);
  });

  it("continue is disabled until a role is chosen, then carries it to sign-up", async () => {
    await renderInSafeArea(<RoleScreen />);

    expect(next().props.accessibilityState).toMatchObject({ disabled: true });
    await fireEvent.press(next());
    expect(router.push).not.toHaveBeenCalled();

    await fireEvent.press(pro());
    expect(next().props.accessibilityState).toMatchObject({ disabled: false });
    await fireEvent.press(next());

    expect(router.push).toHaveBeenCalledWith({
      pathname: "/(auth)/sign-up",
      params: { role: "pro" },
    });
  });

  it("radio semantics: a radiogroup with one checked card at a time", async () => {
    await renderInSafeArea(<RoleScreen />);

    expect(screen.getByTestId("role-options").props.accessibilityRole).toBe("radiogroup");
    expect(customer().props.accessibilityState).toMatchObject({ checked: false });
    expect(pro().props.accessibilityState).toMatchObject({ checked: false });

    await fireEvent.press(customer());
    expect(customer().props.accessibilityState).toMatchObject({ checked: true });
    expect(pro().props.accessibilityState).toMatchObject({ checked: false });

    await fireEvent.press(pro());
    expect(customer().props.accessibilityState).toMatchObject({ checked: false });
    expect(pro().props.accessibilityState).toMatchObject({ checked: true });
  });

  it("back returns to the previous step", async () => {
    await renderInSafeArea(<RoleScreen />);

    await fireEvent.press(screen.getByRole("button", { name: "Back" }));

    expect(router.back).toHaveBeenCalledTimes(1);
  });

  describe("reached from Welcome's panel", () => {
    const { transitionMs } = tokens.motion;
    let listeners: Record<string, (event: { data: { closing: boolean } }) => void>;
    /** The stack shows the screen (`transitionStart` comes with the native will-appear). */
    const appear = () => act(async () => listeners.transitionStart({ data: { closing: false } }));
    const layOut = () =>
      act(async () => fireEvent(screen.getByTestId("role-content"), "layout", LAYOUT));
    const advance = (ms: number) => act(async () => jest.advanceTimersByTime(ms));
    /** Ready and the panel settled: the content is in. */
    const enterFully = async () => {
      await layOut();
      await appear();
      await advance(transitionMs * 2);
    };

    beforeEach(() => {
      jest.useFakeTimers();
      jest.mocked(useLocalSearchParams).mockReturnValue({ from: "welcome" });
      panelHandoffStore.setState({ phase: "risen", bar: "light" });
      listeners = {};
      jest.mocked(useNavigation).mockReturnValue({
        addListener: jest.fn((type: string, listener: (typeof listeners)[string]) => {
          listeners[type] = listener;
          return jest.fn();
        }),
      } as never);
    });
    afterEach(() => jest.useRealTimers());

    it("enters once laid out, on screen and the panel risen; then focus moves to the title", async () => {
      jest.mocked(moveAccessibilityFocus).mockClear();
      await renderInSafeArea(<RoleScreen />);
      expect(rootOpacity()).toBe(0); // see-through over the covered panel

      await layOut();
      await appear();
      await advance(transitionMs / 2);
      expect(rootOpacity()).toBeGreaterThan(0);
      expect(rootOpacity()).toBeLessThan(1);
      expect(slide()).toBeGreaterThan(0); // and slides up into place

      await advance(transitionMs);
      expect(rootOpacity()).toBe(1);
      expect(slide()).toBe(0);
      expect(moveAccessibilityFocus).toHaveBeenCalledTimes(1);
      expect(jest.mocked(moveAccessibilityFocus).mock.calls[0][0]).toBeTruthy(); // the title node
    });

    it("ready early (on screen while the panel still rises): waits, then enters as it settles", async () => {
      panelHandoffStore.setState({ phase: "rising" });
      await renderInSafeArea(<RoleScreen />);
      await layOut();
      await appear();
      await advance(transitionMs * 3);
      expect(rootOpacity()).toBe(0);

      await act(async () => panelHandoffStore.setState({ phase: "risen" }));
      await advance(transitionMs / 2);
      expect(rootOpacity()).toBeGreaterThan(0);
      await advance(transitionMs);
      expect(rootOpacity()).toBe(1);
    });

    it("late (the panel settled first): the covered panel holds until it is shown and laid out", async () => {
      await renderInSafeArea(<RoleScreen />);
      await appear();
      await advance(transitionMs * 3);
      expect(rootOpacity()).toBe(0);

      await layOut();
      await advance(transitionMs * 2);
      expect(rootOpacity()).toBe(1);
    });

    it("never fades before the native screen is shown: a layout alone (prefetched) waits", async () => {
      await renderInSafeArea(<RoleScreen />);
      await layOut();
      await advance(transitionMs * 5);
      expect(rootOpacity()).toBe(0);

      await act(async () => listeners.transitionStart({ data: { closing: true } })); // not ours
      await advance(transitionMs * 2);
      expect(rootOpacity()).toBe(0);
    });

    it("until its content is in, the status bar follows the panel's; then the page's", async () => {
      panelHandoffStore.setState({ phase: "rising", bar: "hero" });
      await renderInSafeArea(<RoleScreen />);
      await layOut();
      await appear();
      expect(backdrop()).toContain("bg-navy-900"); // the hero's light icons, mirrored

      await act(async () => panelHandoffStore.setState({ bar: "light" })); // the panel covers it
      expect(backdrop()).toContain("bg-gray-50");
      await act(async () => panelHandoffStore.setState({ phase: "risen" }));
      await advance(transitionMs * 2);
      expect(backdrop()).toContain("bg-gray-50");
    });

    it("shown again (back from sign-up), it neither re-enters nor re-announces", async () => {
      jest.mocked(moveAccessibilityFocus).mockClear();
      await renderInSafeArea(<RoleScreen />);
      await enterFully();
      await appear();
      await advance(transitionMs * 2);
      expect(rootOpacity()).toBe(1);
      expect(moveAccessibilityFocus).toHaveBeenCalledTimes(1);
    });

    it("back fades the screen out over the still-covered panel before it pops", async () => {
      await renderInSafeArea(<RoleScreen />);
      await enterFully();

      await act(async () => fireEvent.press(screen.getByRole("button", { name: "Back" })));
      expect(router.back).not.toHaveBeenCalled();
      await advance(transitionMs / 2);
      expect(rootOpacity()).toBeLessThan(1);

      await advance(transitionMs);
      expect(rootOpacity()).toBe(0);
      expect(router.back).toHaveBeenCalledTimes(1);
    });

    it("Android's hardware back runs the same exit, only while Role is the focused screen", async () => {
      const remove = jest.fn();
      const add = jest
        .spyOn(BackHandler, "addEventListener")
        .mockImplementation(() => ({ remove }));
      await renderInSafeArea(<RoleScreen />);
      await enterFully();

      let blur: (() => void) | void = undefined;
      await act(async () => {
        blur = focus();
      });
      expect(add).toHaveBeenCalledWith("hardwareBackPress", expect.any(Function));
      const onBack = add.mock.calls[0][1] as () => boolean;
      let handled = false;
      await act(async () => {
        handled = onBack();
      });
      expect(handled).toBe(true);
      expect(router.back).not.toHaveBeenCalled();
      await advance(transitionMs * 1.5);
      expect(router.back).toHaveBeenCalledTimes(1);

      // Sign-up pushed on top blurs Role: its listener goes, so sign-up's back is sign-up's.
      await act(async () => (blur as unknown as () => void)());
      expect(remove).toHaveBeenCalledTimes(1);
      add.mockRestore();
    });

    it("takes no taps before its content is in, nor while it leaves", async () => {
      await renderInSafeArea(<RoleScreen />);
      expect(screen.getByTestId("role-root").props.pointerEvents).toBe("none");
      await enterFully();
      expect(screen.getByTestId("role-root").props.pointerEvents).toBe("auto");

      await act(async () => fireEvent.press(screen.getByRole("button", { name: "Back" })));
      expect(screen.getByTestId("role-root").props.pointerEvents).toBe("none");
      await act(async () => fireEvent.press(pro()));
      expect(pro().props.accessibilityState).toMatchObject({ checked: false });
    });

    it("fades as one layer (Android composites a fading view's children apart)", async () => {
      await renderInSafeArea(<RoleScreen />);
      expect(screen.getByTestId("role-root").props.needsOffscreenAlphaCompositing).toBe(true);
    });

    it("under Reduce Motion it only fades, a crossfade over Welcome: no slide", async () => {
      jest.mocked(useReducedMotion).mockReturnValue(true);
      await renderInSafeArea(<RoleScreen />);
      await layOut();
      await appear();
      await advance(transitionMs / 2);
      expect(rootOpacity()).toBeGreaterThan(0);
      expect(rootOpacity()).toBeLessThan(1);
      expect(slide()).toBe(0);
    });

    it("reached any other way, the screen is simply there", async () => {
      jest.mocked(useLocalSearchParams).mockReturnValue({});
      await renderInSafeArea(<RoleScreen />);
      expect(rootOpacity()).toBe(1);
      expect(backdrop()).toContain("bg-gray-50");
      await act(async () => fireEvent.press(screen.getByRole("button", { name: "Back" })));
      expect(router.back).toHaveBeenCalledTimes(1); // at once
    });
  });
});
