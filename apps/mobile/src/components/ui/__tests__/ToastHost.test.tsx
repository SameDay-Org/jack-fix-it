import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { AccessibilityInfo, Keyboard, Platform, type KeyboardEvent } from "react-native";
import { useReducedMotion, withTiming } from "react-native-reanimated";

import { SafeAreaInsetsContext } from "react-native-safe-area-context";

import { tokens } from "@/theme";

import "@/i18n";

import { dismissToast, showToast, toastStore } from "../toast";
import { ToastHost } from "../ToastHost";

jest.mock("react-native-reanimated", () => {
  const actual =
    jest.requireActual<typeof import("react-native-reanimated")>("react-native-reanimated");
  return {
    __esModule: true,
    ...actual,
    useReducedMotion: jest.fn(() => false),
    withTiming: jest.fn(actual.withTiming),
  };
});
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);
jest.mock("expo-glass-effect", () => ({
  GlassView: () => null,
  isLiquidGlassAvailable: () => false,
  isGlassEffectAPIAvailable: () => false,
}));

const announce = jest.spyOn(AccessibilityInfo, "announceForAccessibility");

describe("ToastHost", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.mocked(useReducedMotion).mockReturnValue(false);
    jest.mocked(withTiming).mockClear();
    announce.mockClear();
    dismissToast();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("renders nothing without a toast", async () => {
    await render(<ToastHost />);

    expect(screen.queryByTestId("toast")).toBeNull();
  });

  it("renders message, tone indicator and translated dismiss", async () => {
    await render(<ToastHost />);

    await act(() => showToast({ message: "Visit confirmed", tone: "success" }));

    expect(screen.getByText("Visit confirmed").props.className).toContain("text-navy-900");
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Dismiss" }).props.className).toContain("min-h-12");
    const indicators = screen
      .getByTestId("toast")
      .queryAll(
        (node) =>
          typeof node.props.className === "string" && node.props.className.includes("bg-success"),
      );
    expect(indicators).toHaveLength(1);
    expect(indicators[0].props.className).toContain("rounded-pill");
  });

  it("announces the message for accessibility", async () => {
    await render(<ToastHost />);

    await act(() => showToast({ message: "Could not reach the server", tone: "danger" }));

    expect(announce).toHaveBeenCalledWith("Could not reach the server");
  });

  it("slides and fades over the transition token, and not at all when reduce motion is on", async () => {
    await render(<ToastHost />);
    await act(() => showToast({ message: "Saved", tone: "neutral" }));
    expect(withTiming).toHaveBeenLastCalledWith(1, { duration: tokens.motion.transitionMs });
    expect(screen.getByTestId("toast").props.entering).toBeUndefined(); // no layout animation

    jest.mocked(useReducedMotion).mockReturnValue(true);
    await act(() => showToast({ message: "Saved again", tone: "neutral" }));

    expect(withTiming).toHaveBeenLastCalledWith(1, { duration: 0 });
    expect(screen.getByText("Saved again")).toBeTruthy();
  });

  it("tap dismisses", async () => {
    await render(<ToastHost />);
    await act(() => showToast({ message: "Saved", tone: "neutral" }));

    await fireEvent.press(screen.getByRole("alert"));

    expect(toastStore.getState().current).toBeNull();
    await act(async () => {
      jest.advanceTimersByTime(tokens.motion.toastMs);
    });
    expect(screen.queryByTestId("toast")).toBeNull();
  });

  it("the dismiss action dismisses", async () => {
    await render(<ToastHost />);
    await act(() => showToast({ message: "Saved", tone: "neutral" }));

    await fireEvent.press(screen.getByRole("button", { name: "Dismiss" }));

    expect(toastStore.getState().current).toBeNull();
  });

  describe("with the keyboard up", () => {
    const BOTTOM_INSET = 34;
    const KEYBOARD_HEIGHT = 300;
    const handlers = new Map<string, (event: KeyboardEvent) => void>();
    const keyboard = (name: string, height: number) =>
      act(() => handlers.get(name)?.({ endCoordinates: { height } } as unknown as KeyboardEvent));
    const lift = () => screen.getByTestId("toast-host").props.style.paddingBottom;

    beforeEach(() => {
      handlers.clear();
      jest.spyOn(Keyboard, "addListener").mockImplementation((name, handler) => {
        handlers.set(name, handler as (event: KeyboardEvent) => void);
        return { remove: () => handlers.delete(name) } as ReturnType<typeof Keyboard.addListener>;
      });
    });
    afterEach(() => jest.restoreAllMocks());

    const renderWithInset = () =>
      render(
        <SafeAreaInsetsContext.Provider value={{ top: 0, right: 0, bottom: BOTTOM_INSET, left: 0 }}>
          <ToastHost />
        </SafeAreaInsetsContext.Provider>,
      );

    it("android: rises by the keyboard plus the bars it leaves out, and back down", async () => {
      jest.replaceProperty(Platform, "OS", "android");
      await renderWithInset();
      await act(() => showToast({ message: "We sent a new code.", tone: "neutral" }));
      expect(lift()).toBe(BOTTOM_INSET);

      await keyboard("keyboardDidShow", KEYBOARD_HEIGHT);
      expect(lift()).toBe(KEYBOARD_HEIGHT + BOTTOM_INSET);

      await keyboard("keyboardDidHide", 0);
      expect(lift()).toBe(BOTTOM_INSET);
    });

    it("ios: rises by the keyboard, which already covers the home indicator", async () => {
      jest.replaceProperty(Platform, "OS", "ios");
      await renderWithInset();
      await act(() => showToast({ message: "We sent a new code.", tone: "neutral" }));

      await keyboard("keyboardWillShow", KEYBOARD_HEIGHT);
      expect(lift()).toBe(KEYBOARD_HEIGHT);

      await keyboard("keyboardWillHide", 0);
      expect(lift()).toBe(BOTTOM_INSET);
    });
  });
});
