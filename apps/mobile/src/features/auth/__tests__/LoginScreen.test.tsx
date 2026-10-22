import "@/i18n";

import { act, fireEvent, screen } from "@testing-library/react-native";
import { router, useLocalSearchParams, useNavigation } from "expo-router";
import { AccessibilityInfo } from "react-native";

import { ApiError, login } from "@/api";
import { moveAccessibilityFocus } from "@/components/ui";
import { tokens } from "@/theme";

import { LoginScreen } from "../LoginScreen";
import { createPanelHandoff, type PanelHandoff } from "../panelHandoff";
import { renderInSafeArea } from "./helpers";

jest.mock(
  "../../../api/config",
  () => jest.requireActual("../../../api/__tests__/helpers").configMock,
);
jest.mock(
  "expo-secure-store",
  () => jest.requireActual("../../../api/__tests__/helpers").secureStoreMock,
);
jest.mock("@/api", () => ({ ...jest.requireActual("@/api"), login: jest.fn() }));
jest.mock("expo-router", () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true) },
  useLocalSearchParams: jest.fn(() => ({})),
  // The focus effect (hardware back while focused) runs only where a test calls it.
  useFocusEffect: jest.fn(),
  useIsFocused: jest.fn(() => true),
  // The stack's events: `transitionEnd` tells the content its screen has appeared.
  useNavigation: jest.fn(() => ({ addListener: jest.fn(() => jest.fn()) })),
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

async function fillAndSubmit(address: string, secret: string) {
  await fireEvent.changeText(screen.getByLabelText("Email"), address);
  await fireEvent.changeText(screen.getByLabelText("Password"), secret);
  await fireEvent.press(screen.getByRole("button", { name: "Log in" }));
}

let handoff: PanelHandoff = createPanelHandoff();

describe("LoginScreen", () => {
  beforeEach(() => {
    handoff = createPanelHandoff();
  });

  beforeEach(() => {
    jest.mocked(login).mockReset();
    jest.spyOn(AccessibilityInfo, "announceForAccessibility").mockImplementation(() => undefined);
  });

  it.each([
    [401, "invalid_credentials", "Email or password is incorrect."],
    [403, "account_suspended", "This account is suspended. Contact support."],
    [429, "rate_limited", "Too many attempts. Try again in a moment."],
  ])("maps %s %s to its message", async (status, code, message) => {
    jest.mocked(login).mockRejectedValue(new ApiError(status, code));
    await renderInSafeArea(<LoginScreen />, handoff);

    await fillAndSubmit("maria@example.com", "correct horse battery");

    expect(await screen.findByText(message)).toBeTruthy();
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith(message);
  });

  it("submits the normalized email with the current-password autofill intent and no reset link", async () => {
    jest.mocked(login).mockResolvedValue(undefined);
    await renderInSafeArea(<LoginScreen />, handoff);

    expect(screen.getByLabelText("Password").props.textContentType).toBe("password");
    expect(screen.getByLabelText("Password").props.autoComplete).toBe("current-password");
    expect(screen.queryByText(/forgot/i)).toBeNull();

    await fillAndSubmit("Maria@Example.com", "correct horse battery");

    expect(login).toHaveBeenCalledWith({
      email: "maria@example.com",
      password: "correct horse battery",
    });
  });

  describe("reached from Welcome's panel", () => {
    const { transitionMs } = tokens.motion;
    const LAYOUT = { nativeEvent: { layout: { x: 0, y: 0, width: 320, height: 600 } } };
    const rootOpacity = () =>
      (
        screen.getByTestId("login-screen-root").props.jestAnimatedStyle as {
          value: { opacity: number };
        }
      ).value.opacity;
    let showScreen: () => void;
    /** Laid out and shown by the stack: with the panel risen, the content enters. */
    const ready = async () => {
      await act(async () =>
        fireEvent(screen.getByTestId("login-screen-content"), "layout", LAYOUT),
      );
      await act(async () => showScreen());
    };
    beforeEach(() => {
      jest.useFakeTimers();
      jest.mocked(useLocalSearchParams).mockReturnValue({ from: "welcome" });
      jest.mocked(router.back).mockClear();
      handoff.store.setState({ phase: "risen", bar: "light" });
      jest.mocked(useNavigation).mockReturnValue({
        addListener: jest.fn((_type: string, listener: (event: object) => void) => {
          showScreen = () => listener({ data: { closing: false } });
          return jest.fn();
        }),
      } as never);
    });
    afterEach(() => {
      jest.useRealTimers();
      jest.mocked(useLocalSearchParams).mockReturnValue({});
    });

    it("content enters after the panel settles, then focus moves to the title", async () => {
      jest.mocked(moveAccessibilityFocus).mockClear();
      await renderInSafeArea(<LoginScreen />, handoff);
      expect(rootOpacity()).toBe(0);
      await ready();

      await act(async () => jest.advanceTimersByTime(transitionMs * 1.5));

      expect(rootOpacity()).toBe(1);
      expect(moveAccessibilityFocus).toHaveBeenCalledTimes(1);
      expect(jest.mocked(moveAccessibilityFocus).mock.calls[0][0]).toBeTruthy(); // the title node
      expect(screen.getByRole("header", { name: "Welcome back" })).toBeTruthy();
    });

    it("the screen fades as one layer, and takes no taps before its content is in", async () => {
      await renderInSafeArea(<LoginScreen />, handoff);
      const root = screen.getByTestId("login-screen-root");
      expect(root.props.needsOffscreenAlphaCompositing).toBe(true);
      expect(root.props.pointerEvents).toBe("none");
    });

    it("back fades the content out before it pops", async () => {
      await renderInSafeArea(<LoginScreen />, handoff);
      await ready();
      await act(async () => jest.advanceTimersByTime(transitionMs * 2));

      await act(async () => fireEvent.press(screen.getByRole("button", { name: "Back" })));
      expect(router.back).not.toHaveBeenCalled();
      await act(async () => jest.advanceTimersByTime(transitionMs * 1.5));
      expect(rootOpacity()).toBe(0);
      expect(router.back).toHaveBeenCalledTimes(1);
    });
  });
});
