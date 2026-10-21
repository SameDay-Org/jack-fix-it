import "@/i18n";

import { act, fireEvent, renderRouter, screen } from "expo-router/testing-library";
import * as SplashScreen from "expo-splash-screen";
import { createElement, useCallback, useState } from "react";
import { Text } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { useSession } from "@/api";
import { tokens } from "@/theme";

import { user } from "../../../api/__tests__/helpers";
import AppLayout from "../../../app/(app)/_layout";
import AuthLayout, { unstable_settings } from "../../../app/(auth)/_layout";
import { SessionGate } from "../../auth/SessionGate";
import { METRICS, SIGNED_OUT } from "../../auth/__tests__/helpers";
import { LaunchIntro } from "../LaunchIntro";

jest.mock("@/api", () => ({
  useSession: jest.fn(),
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
// `expo-router/testing-library` installs Reanimated's official mock: timings call back at once
// (so the exit completes in the same tick), `useReducedMotion` is false and `withSequence` is a
// no-op, so the rotator stays on its first word here; its own suite covers the swaps.

type Session = ReturnType<typeof useSession>;
const { accessToken: _a, accessTokenExpiresAt: _b, ...SESSION_SIGNED_OUT } = SIGNED_OUT;
const session = (overrides: Partial<Session>) =>
  jest.mocked(useSession).mockReturnValue({ ...SESSION_SIGNED_OUT, ...overrides });

/** The root layout's composition: the gate under the intro, the intro lifting the splash. */
function Root() {
  const [introShown, setIntroShown] = useState(true);
  const lift = useCallback(() => void SplashScreen.hideAsync(), []);
  const done = useCallback(() => setIntroShown(false), []);
  return (
    <SafeAreaProvider initialMetrics={METRICS}>
      <SessionGate />
      {introShown ? <LaunchIntro onReady={lift} onDone={done} /> : null}
    </SafeAreaProvider>
  );
}

const routes = {
  _layout: () => createElement(Root),
  "(auth)/_layout": { default: AuthLayout, unstable_settings },
  "(auth)/welcome": () => <Text>welcome stub</Text>,
  "(app)/_layout": AppLayout,
  "(app)/index": () => <Text>app stub</Text>,
};

const { launchMinMs, launchMaxMs } = tokens.motion;

/** The minimum run elapses; with the session resolved the intro exits (at once, under the mock). */
async function finishIntro() {
  await act(async () => jest.advanceTimersByTime(launchMinMs + 1));
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.mocked(SplashScreen.hideAsync).mockClear();
});
afterEach(() => jest.useRealTimers());

describe("LaunchIntro over the session gate", () => {
  it("draws the hero with the headline and the first word, hides the rolling words from screen readers", async () => {
    session({ status: "signedOut" });
    await renderRouter(routes);

    expect(screen.getByTestId("launch-intro")).toBeTruthy();
    const headline = screen.getByTestId("launch-hero-headline");
    expect(headline.props.accessibilityLabel).toBe("Whatever happens at home, we fix it.");
    expect(
      screen.getByTestId("launch-rotator", { includeHiddenElements: true }).props
        .importantForAccessibility,
    ).toBe("no-hide-descendants");
    expect(screen.getByRole("button", { name: "Skip intro" })).toBeTruthy();
    expect(screen.getByText("Jack Fix It")).toBeTruthy();
  });

  it("restoring: the gate shows the static hero under the intro, the splash stays until the intro is ready, and the intro never outlives launchMaxMs", async () => {
    session({ status: "restoring" });
    await renderRouter(routes);

    expect(screen.getByTestId("restoring-hero")).toBeTruthy();
    expect(SplashScreen.hideAsync).not.toHaveBeenCalled();

    await act(async () => jest.advanceTimersByTime(launchMinMs + 1));
    expect(screen.getByTestId("launch-intro")).toBeTruthy(); // nothing to hand off to yet

    await act(async () => jest.advanceTimersByTime(launchMaxMs - launchMinMs));
    expect(SplashScreen.hideAsync).toHaveBeenCalledTimes(1); // the fallback lifts it at the latest
    expect(screen.queryByTestId("launch-intro")).toBeNull();
    expect(screen.getByTestId("restoring-hero")).toBeTruthy(); // the gate's own frame remains
  });

  it("routes signed out to welcome", async () => {
    session({ status: "signedOut" });
    const result = await renderRouter(routes);

    await finishIntro();

    expect(screen.queryByTestId("launch-intro")).toBeNull();
    expect(result.getPathname()).toBe("/welcome");
    expect(screen.getByText("welcome stub")).toBeTruthy();
  });

  it("routes signed in to app", async () => {
    session({ status: "signedIn", user });
    const result = await renderRouter(routes);

    await finishIntro();

    expect(screen.queryByTestId("launch-intro")).toBeNull();
    expect(result.getPathname()).toBe("/");
    expect(screen.getByText("app stub")).toBeTruthy();
  });

  it("routes a failed restore to the offline screen", async () => {
    session({ status: "signedOut", restoreFailure: "offline" });
    await renderRouter(routes);

    await finishIntro();

    expect(screen.queryByTestId("launch-intro")).toBeNull();
    expect(screen.getByText("Can't reach Jack right now")).toBeTruthy();
  });

  it("tap skips immediately", async () => {
    session({ status: "restoring" });
    await renderRouter(routes);
    expect(screen.getByTestId("launch-intro")).toBeTruthy();

    await act(async () => fireEvent.press(screen.getByRole("button", { name: "Skip intro" })));

    expect(screen.queryByTestId("launch-intro")).toBeNull();
    expect(screen.getByTestId("restoring-hero")).toBeTruthy(); // the gate's own frame remains
  });
});
