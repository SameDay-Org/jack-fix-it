import "@/i18n";

import { act, fireEvent, renderRouter, screen, within } from "expo-router/testing-library";
import * as SplashScreen from "expo-splash-screen";
import { createElement } from "react";
import { Text } from "react-native";
import * as Reanimated from "react-native-reanimated";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { tokens } from "@/theme";

import { user } from "../../../api/__tests__/helpers";
import AppLayout from "../../../app/(app)/_layout";
import AuthLayout, { unstable_settings } from "../../../app/(auth)/_layout";
import { METRICS, SIGNED_OUT } from "../../auth/__tests__/helpers";
import { LaunchShell } from "../LaunchShell";
import { resetSplashForTests } from "../splash";

// The session as a tiny store the test can change under a mounted tree (a restore resolving).
type Session = ReturnType<typeof import("@/api").useSession>;
const { accessToken: _a, accessTokenExpiresAt: _b, ...SESSION_SIGNED_OUT } = SIGNED_OUT;
const mockSession: { current: Session; listeners: Set<() => void> } = {
  current: SESSION_SIGNED_OUT,
  listeners: new Set(),
};
const setSession = (next: Partial<Session>) =>
  act(async () => {
    mockSession.current = { ...SESSION_SIGNED_OUT, ...next };
    mockSession.listeners.forEach((listen) => listen());
  });

jest.mock("@/api", () => ({
  useSession: () =>
    jest.requireActual<typeof import("react")>("react").useSyncExternalStore(
      (listen: () => void) => {
        mockSession.listeners.add(listen);
        return () => mockSession.listeners.delete(listen);
      },
      () => mockSession.current,
    ),
  logout: jest.fn(async () => undefined),
  restoreSession: jest.fn(async () => undefined),
}));
jest.mock("expo-splash-screen", () => ({
  preventAutoHideAsync: jest.fn(async () => true),
  hideAsync: jest.fn(async () => true),
}));
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);
// `expo-router/testing-library` installs Reanimated's official mock: timings call back at once, so
// an exit completes in the same tick and the rotator stays on its first word (its own suite covers
// the swaps). Reduce Motion is a spy on that mock's export.
const reduceMotion = () => jest.spyOn(Reanimated, "useReducedMotion");

const routes = {
  _layout: () =>
    createElement(SafeAreaProvider, { initialMetrics: METRICS }, createElement(LaunchShell)),
  "(auth)/_layout": { default: AuthLayout, unstable_settings },
  "(auth)/welcome": () => <Text accessibilityRole="header">welcome stub</Text>,
  "(app)/_layout": AppLayout,
  "(app)/index": () => <Text>app stub</Text>,
};

const { launchMinMs, launchMaxMs } = tokens.motion;
const HIDDEN = { includeHiddenElements: true };

/** Lays out the rotator's hidden measurement row, as the native side would: the first frame is final. */
async function measureWords() {
  const row = within(screen.getByTestId("launch-rotator-measure", HIDDEN));
  await act(async () => {
    for (const word of ["fix", "clean", "paint", "mow", "move"]) {
      fireEvent(row.getByText(word, HIDDEN), "layout", {
        nativeEvent: { layout: { width: 40, height: 40, x: 0, y: 0 } },
      });
    }
  });
}

/** Measured, then the minimum elapses (the run settles at once under the mock): a resolved session exits. */
async function finishIntro() {
  await measureWords();
  await act(async () => jest.advanceTimersByTime(launchMinMs + 1));
}

beforeEach(() => {
  jest.useFakeTimers();
  resetSplashForTests();
  jest.mocked(SplashScreen.hideAsync).mockClear();
  reduceMotion().mockReturnValue(false);
  mockSession.current = SESSION_SIGNED_OUT;
});
afterEach(() => jest.useRealTimers());

describe("LaunchShell: the intro over the gate", () => {
  it("draws the hero with the headline and the first word, Skip reachable, the rolling words hidden", async () => {
    await renderRouter(routes);

    expect(screen.getByTestId("launch-intro")).toBeTruthy();
    const headline = screen.getByTestId("launch-hero-headline");
    expect(headline.props.accessibilityLabel).toBe("Whatever happens at home, we fix it.");
    expect(screen.getByTestId("launch-rotator", HIDDEN).props.importantForAccessibility).toBe(
      "no-hide-descendants",
    );
    expect(screen.getByRole("button", { name: "Skip intro" })).toBeTruthy();
    expect(screen.getByText("Jack Fix It")).toBeTruthy();
    // Skip floats over the frame: the hero under the intro has none, and the sentence must not
    // move when the intro lifts.
    const skipRow = screen.getByTestId("launch-hero-skip-row");
    expect(skipRow.props.className).toContain("absolute");
    expect(skipRow.props.style).toEqual({ bottom: METRICS.insets.bottom });
  });

  it("while the intro shows, what it covers is hidden from assistive technology; after, it is reachable", async () => {
    await renderRouter(routes); // signed out: Welcome mounts under the intro
    await measureWords();

    expect(screen.getAllByRole("header")).toHaveLength(1); // the intro's sentence only
    expect(screen.getByRole("button", { name: "Skip intro" })).toBeTruthy();
    expect(screen.queryByText("welcome stub")).toBeNull(); // there, but not for a screen reader
    expect(screen.getByText("welcome stub", HIDDEN)).toBeTruthy();

    await act(async () => jest.advanceTimersByTime(launchMinMs + 1));

    expect(screen.queryByTestId("launch-intro")).toBeNull();
    expect(screen.getByRole("header", { name: "welcome stub" })).toBeTruthy();
    expect(screen.getByTestId("launch-shell-content").props.accessibilityElementsHidden).toBe(
      false,
    );
  });

  it("restoring: the gate's static hero is one more covered header, and the intro never outlives launchMaxMs", async () => {
    mockSession.current = { ...SESSION_SIGNED_OUT, status: "restoring" };
    await renderRouter(routes);
    await measureWords();

    expect(screen.getByTestId("restoring-hero", HIDDEN)).toBeTruthy();
    expect(screen.getAllByRole("header")).toHaveLength(1);
    expect(SplashScreen.hideAsync).toHaveBeenCalledTimes(1); // the first final frame lifted it

    await act(async () => jest.advanceTimersByTime(launchMinMs + 1));
    expect(screen.getByTestId("launch-intro")).toBeTruthy(); // nothing to hand off to yet

    await act(async () => jest.advanceTimersByTime(launchMaxMs - launchMinMs));
    expect(screen.queryByTestId("launch-intro")).toBeNull();
    expect(screen.getByTestId("restoring-hero")).toBeTruthy(); // the gate's own frame remains
    expect(SplashScreen.hideAsync).toHaveBeenCalledTimes(1);
  });

  it("the splash is released at launchMaxMs even when the intro never measures a word", async () => {
    mockSession.current = { ...SESSION_SIGNED_OUT, status: "restoring" };
    await renderRouter(routes);

    await act(async () => jest.advanceTimersByTime(launchMaxMs - 1));
    expect(SplashScreen.hideAsync).not.toHaveBeenCalled();

    await act(async () => jest.advanceTimersByTime(2));
    expect(SplashScreen.hideAsync).toHaveBeenCalledTimes(1);
  });

  it("Reduce Motion with a restore that resolves before measurement: the intro leaves and the splash is still released, once", async () => {
    reduceMotion().mockReturnValue(true);
    mockSession.current = { ...SESSION_SIGNED_OUT, status: "restoring" };
    await renderRouter(routes);
    expect(screen.getByTestId("launch-intro")).toBeTruthy();
    expect(SplashScreen.hideAsync).not.toHaveBeenCalled();

    await setSession({ status: "signedOut" }); // before any word was measured

    expect(screen.queryByTestId("launch-intro")).toBeNull();
    expect(SplashScreen.hideAsync).toHaveBeenCalledTimes(1);

    await act(async () => jest.advanceTimersByTime(launchMaxMs + 1));
    expect(SplashScreen.hideAsync).toHaveBeenCalledTimes(1); // the guard does not call it again
  });

  it("routes signed out to welcome", async () => {
    const result = await renderRouter(routes);

    await finishIntro();

    expect(screen.queryByTestId("launch-intro")).toBeNull();
    expect(result.getPathname()).toBe("/welcome");
    expect(screen.getByText("welcome stub")).toBeTruthy();
    expect(SplashScreen.hideAsync).toHaveBeenCalledTimes(1);
  });

  it("routes signed in to app", async () => {
    mockSession.current = { ...SESSION_SIGNED_OUT, status: "signedIn", user };
    const result = await renderRouter(routes);

    await finishIntro();

    expect(screen.queryByTestId("launch-intro")).toBeNull();
    expect(result.getPathname()).toBe("/");
    expect(screen.getByText("app stub")).toBeTruthy();
  });

  it("routes a failed restore to the offline screen", async () => {
    mockSession.current = { ...SESSION_SIGNED_OUT, status: "signedOut", restoreFailure: "offline" };
    await renderRouter(routes);

    await finishIntro();

    expect(screen.queryByTestId("launch-intro")).toBeNull();
    expect(screen.getByText("Can't reach Jack right now")).toBeTruthy();
  });

  it("tap skips immediately and releases the splash", async () => {
    mockSession.current = { ...SESSION_SIGNED_OUT, status: "restoring" };
    await renderRouter(routes);
    expect(screen.getByTestId("launch-intro")).toBeTruthy();

    await act(async () => fireEvent.press(screen.getByRole("button", { name: "Skip intro" })));

    expect(screen.queryByTestId("launch-intro")).toBeNull();
    expect(screen.getByTestId("restoring-hero")).toBeTruthy(); // the gate's own frame remains
    expect(SplashScreen.hideAsync).toHaveBeenCalledTimes(1);
  });
});
