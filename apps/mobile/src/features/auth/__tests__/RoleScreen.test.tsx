import "@/i18n";

import { act, fireEvent, screen } from "@testing-library/react-native";
import { router, useFocusEffect, useLocalSearchParams, useNavigation } from "expo-router";
import { BackHandler, Platform } from "react-native";
import { useReducedMotion } from "react-native-reanimated";

import { moveAccessibilityFocus } from "@/components/ui";
import { tokens } from "@/theme";

import { RoleScreen } from "../RoleScreen";
import { renderInSafeArea } from "./helpers";

jest.mock("expo-router", () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true) },
  useLocalSearchParams: jest.fn(() => ({})),
  // The focus effect (hardware back while focused) runs only where a test calls it.
  useFocusEffect: jest.fn(),
  // The stack's events: `transitionEnd` tells the content its screen has appeared.
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
type ContentStyle = { opacity: number; transform?: { translateY: number }[] };
const contentStyle = () =>
  (screen.getByTestId("role-content").props.jestAnimatedStyle as { value: ContentStyle }).value;

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
    beforeEach(() => {
      jest.useFakeTimers();
      jest.mocked(useLocalSearchParams).mockReturnValue({ from: "welcome" });
    });
    afterEach(() => jest.useRealTimers());

    it("content enters after the panel settles, then focus moves to the title", async () => {
      jest.mocked(moveAccessibilityFocus).mockClear();
      await renderInSafeArea(<RoleScreen />);
      expect(contentStyle().opacity).toBe(0); // the page the panel became is bare for a frame
      await act(async () => fireEvent(screen.getByTestId("role-content"), "layout", LAYOUT));

      await act(async () => jest.advanceTimersByTime(transitionMs / 2));
      expect(contentStyle().opacity).toBeGreaterThan(0);
      expect(contentStyle().opacity).toBeLessThan(1);

      await act(async () => jest.advanceTimersByTime(transitionMs));
      expect(contentStyle().opacity).toBe(1);
      expect(moveAccessibilityFocus).toHaveBeenCalledTimes(1);
      expect(jest.mocked(moveAccessibilityFocus).mock.calls[0][0]).toBeTruthy(); // the title node
      expect(screen.getByRole("header", { name: "How will you use Jack?" })).toBeTruthy();
    });

    it("back fades the content out before it pops", async () => {
      await renderInSafeArea(<RoleScreen />);
      await act(async () => fireEvent(screen.getByTestId("role-content"), "layout", LAYOUT));
      await act(async () => jest.advanceTimersByTime(transitionMs * 2));

      await act(async () => fireEvent.press(screen.getByRole("button", { name: "Back" })));
      expect(router.back).not.toHaveBeenCalled();
      await act(async () => jest.advanceTimersByTime(transitionMs / 2));
      expect(contentStyle().opacity).toBeLessThan(1);

      await act(async () => jest.advanceTimersByTime(transitionMs));
      expect(contentStyle().opacity).toBe(0);
      expect(router.back).toHaveBeenCalledTimes(1);
    });

    it("Android's hardware back runs the same exit, only while Role is the focused screen", async () => {
      const remove = jest.fn();
      const add = jest
        .spyOn(BackHandler, "addEventListener")
        .mockImplementation(() => ({ remove }));
      await renderInSafeArea(<RoleScreen />);
      await act(async () => fireEvent(screen.getByTestId("role-content"), "layout", LAYOUT));
      await act(async () => jest.advanceTimersByTime(transitionMs * 2));

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
      await act(async () => jest.advanceTimersByTime(transitionMs * 1.5));
      expect(router.back).toHaveBeenCalledTimes(1);

      // Sign-up pushed on top blurs Role: its listener goes, so sign-up's back is sign-up's.
      await act(async () => (blur as unknown as () => void)());
      expect(remove).toHaveBeenCalledTimes(1);
      add.mockRestore();
    });

    it("the content takes no taps while it leaves", async () => {
      await renderInSafeArea(<RoleScreen />);
      await act(async () => fireEvent(screen.getByTestId("role-content"), "layout", LAYOUT));
      await act(async () => jest.advanceTimersByTime(transitionMs * 2));
      expect(screen.getByTestId("role-content").props.pointerEvents).toBe("auto");

      await act(async () => fireEvent.press(screen.getByRole("button", { name: "Back" })));
      expect(screen.getByTestId("role-content").props.pointerEvents).toBe("none");
      await act(async () => fireEvent.press(pro()));
      expect(pro().props.accessibilityState).toMatchObject({ checked: false });
    });

    it("the content fades as one layer (Android composites a fading view's children apart)", async () => {
      await renderInSafeArea(<RoleScreen />);
      expect(screen.getByTestId("role-content").props.needsOffscreenAlphaCompositing).toBe(true);
    });

    it("under Reduce Motion the content only fades: no slide", async () => {
      jest.mocked(useReducedMotion).mockReturnValue(true);
      await renderInSafeArea(<RoleScreen />);
      await act(async () => fireEvent(screen.getByTestId("role-content"), "layout", LAYOUT));
      await act(async () => jest.advanceTimersByTime(transitionMs / 2));
      expect(contentStyle().opacity).toBeGreaterThan(0);
      expect(contentStyle().opacity).toBeLessThan(1);
      expect(contentStyle().transform?.[0].translateY).toBe(0);
    });

    describe("on Android, where the route appears with no stack motion", () => {
      let listeners: Record<string, (event: { data: { closing: boolean } }) => void>;
      beforeEach(() => {
        jest.replaceProperty(Platform, "OS", "android");
        listeners = {};
        jest.mocked(useNavigation).mockReturnValue({
          addListener: jest.fn((type: string, listener: (typeof listeners)[string]) => {
            listeners[type] = listener;
            return jest.fn();
          }),
        } as never);
      });
      afterEach(() => jest.restoreAllMocks());

      it("the content enters once the screen has appeared, not on its first layout", async () => {
        await renderInSafeArea(<RoleScreen />);
        await act(async () => fireEvent(screen.getByTestId("role-content"), "layout", LAYOUT));
        await act(async () => jest.advanceTimersByTime(transitionMs));
        expect(contentStyle().opacity).toBe(0); // still waiting: a fade now would run unseen

        await act(async () => listeners.transitionEnd({ data: { closing: false } }));
        await act(async () => jest.advanceTimersByTime(transitionMs / 2));
        expect(contentStyle().opacity).toBeGreaterThan(0);
        await act(async () => jest.advanceTimersByTime(transitionMs));
        expect(contentStyle().opacity).toBe(1);
      });

      it("if the stack never reports it, the content enters anyway after one rise", async () => {
        const { panelRiseMs } = tokens.motion;
        await renderInSafeArea(<RoleScreen />);
        await act(async () => fireEvent(screen.getByTestId("role-content"), "layout", LAYOUT));
        await act(async () => jest.advanceTimersByTime(panelRiseMs + transitionMs * 2));
        expect(contentStyle().opacity).toBe(1);
      });
    });

    it("reached any other way, the content is simply there", async () => {
      jest.mocked(useLocalSearchParams).mockReturnValue({});
      await renderInSafeArea(<RoleScreen />);
      expect(contentStyle().opacity).toBe(1);
      await act(async () => fireEvent.press(screen.getByRole("button", { name: "Back" })));
      expect(router.back).toHaveBeenCalledTimes(1); // at once
    });
  });
});
