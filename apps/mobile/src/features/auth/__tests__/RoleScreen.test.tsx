import "@/i18n";

import { act, fireEvent, screen } from "@testing-library/react-native";
import { router, useLocalSearchParams } from "expo-router";

import { moveAccessibilityFocus } from "@/components/ui";
import { tokens } from "@/theme";

import { RoleScreen } from "../RoleScreen";
import { renderInSafeArea } from "./helpers";

jest.mock("expo-router", () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true) },
  useLocalSearchParams: jest.fn(() => ({})),
}));
jest.mock("@/components/ui", () => ({
  ...jest.requireActual("@/components/ui"),
  moveAccessibilityFocus: jest.fn(),
}));
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);

const customer = () => screen.getByRole("radio", { name: "I need help at home" });
const pro = () => screen.getByRole("radio", { name: "I'm a pro" });
const next = () => screen.getByRole("button", { name: "Continue" });

const LAYOUT = { nativeEvent: { layout: { x: 0, y: 0, width: 320, height: 600 } } };
const contentStyle = () =>
  (screen.getByTestId("role-content").props.jestAnimatedStyle as { value: { opacity: number } })
    .value;

describe("RoleScreen", () => {
  beforeEach(() => {
    jest.mocked(router.push).mockClear();
    jest.mocked(router.back).mockClear();
    jest.mocked(useLocalSearchParams).mockReturnValue({});
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

    it("reached any other way, the content is simply there", async () => {
      jest.mocked(useLocalSearchParams).mockReturnValue({});
      await renderInSafeArea(<RoleScreen />);
      expect(contentStyle().opacity).toBe(1);
      await act(async () => fireEvent.press(screen.getByRole("button", { name: "Back" })));
      expect(router.back).toHaveBeenCalledTimes(1); // at once
    });
  });
});
