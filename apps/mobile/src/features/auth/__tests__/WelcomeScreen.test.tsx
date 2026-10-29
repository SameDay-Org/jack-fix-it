import "@/i18n";

import { act, fireEvent, screen } from "@testing-library/react-native";
import { router } from "expo-router";

import { useSession } from "@/api";
import { tokens } from "@/theme";

import { WelcomeScreen } from "../WelcomeScreen";
import { renderInSafeArea, SIGNED_OUT } from "./helpers";

jest.mock("@/api", () => ({ useSession: jest.fn() }));
jest.mock("expo-router", () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true) },
  useFocusEffect: jest.fn(),
  useNavigation: jest.fn(() => ({ isFocused: () => false })),
  unstable_useIsNavigating: () => false,
}));
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);

const { accessToken: _a, accessTokenExpiresAt: _b, ...SESSION_SIGNED_OUT } = SIGNED_OUT;
const { panelRiseMs } = tokens.motion;

describe("WelcomeScreen", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.mocked(useSession).mockReturnValue(SESSION_SIGNED_OUT);
    jest.mocked(router.push).mockClear();
  });
  afterEach(() => jest.useRealTimers());

  it("hero copy: brand, tagline with one accent word, support line; two ways in and nothing else", async () => {
    await renderInSafeArea(<WelcomeScreen />);

    expect(screen.getByText("Jack Fix It")).toBeTruthy();
    // The same hero the launch intro draws: one accessible sentence, the lime word in place.
    expect(
      screen.getByRole("header", { name: "Whatever happens at home, we fix it." }),
    ).toBeTruthy();
    // The lime word is there for the eye and hidden from the reader (the header carries the sentence).
    // (The hero's measurement row holds a hidden "fix" too; the visible one comes first.)
    expect(
      screen.getAllByText("fix", { includeHiddenElements: true })[0].props.className,
    ).toContain("text-green-500");
    expect(screen.getByText("Tell Jack. We'll take care of the rest.")).toBeTruthy();
    expect(screen.getAllByRole("button")).toHaveLength(2);
    expect(screen.queryByTestId("welcome-actions-partial-cleanup")).toBeNull();
  });

  // The panel rises first (usePanelTransition.test.tsx covers the motion); the push follows.
  it("Get started goes to the role choice and the account link to login, each after the rise", async () => {
    await renderInSafeArea(<WelcomeScreen />);

    await act(async () => fireEvent.press(screen.getByRole("button", { name: "Get started" })));
    await act(async () => jest.advanceTimersByTime(panelRiseMs * 1.5));
    expect(router.push).toHaveBeenLastCalledWith({
      pathname: "/(auth)/role",
      params: { from: "welcome" },
    });

    await renderInSafeArea(<WelcomeScreen />);
    await act(async () =>
      fireEvent.press(screen.getAllByRole("button", { name: "I already have an account" }).at(-1)!),
    );
    await act(async () => jest.advanceTimersByTime(panelRiseMs * 1.5));
    expect(router.push).toHaveBeenLastCalledWith({
      pathname: "/(auth)/login",
      params: { from: "welcome" },
    });
  });

  it("after a sign-out that could not clear the device, says so", async () => {
    jest.mocked(useSession).mockReturnValue({ ...SESSION_SIGNED_OUT, cleanupPending: true });

    await renderInSafeArea(<WelcomeScreen />);

    const notice = screen.getByRole("alert");
    expect(notice).toHaveTextContent("Signed out. Some data couldn't be cleared from this device.");
  });

  it("pads the bottom inset under the white bubble itself", async () => {
    await renderInSafeArea(<WelcomeScreen />);

    expect(screen.getByTestId("welcome-actions").props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ paddingBottom: 16 })]),
    );
  });
});
