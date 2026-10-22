import "@/i18n";

import { act, fireEvent, screen } from "@testing-library/react-native";
import { router, useFocusEffect, useNavigation } from "expo-router";
import { Platform } from "react-native";
import { useReducedMotion } from "react-native-reanimated";

import { useSession } from "@/api";
import { tokens } from "@/theme";

import { panelHandoffStore, panelProgress, panelTravel } from "../panelHandoff";
import { WelcomeScreen } from "../WelcomeScreen";
import { renderInSafeArea, SIGNED_OUT } from "./helpers";

jest.mock("@/api", () => ({ useSession: jest.fn() }));
jest.mock("expo-router", () => ({
  router: {
    push: jest.fn(),
    replace: jest.fn(),
    back: jest.fn(),
    prefetch: jest.fn(),
    canGoBack: jest.fn(() => true),
  },
  useFocusEffect: jest.fn(),
  useNavigation: jest.fn(),
}));
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);
jest.mock("react-native-reanimated", () => {
  const actual =
    jest.requireActual<typeof import("react-native-reanimated")>("react-native-reanimated");
  return { __esModule: true, ...actual, useReducedMotion: jest.fn(() => false) };
});
// Real Reanimated otherwise: the live animated styles sit on the host elements (`jestAnimatedStyle`).

const { accessToken: _a, accessTokenExpiresAt: _b, ...SESSION_SIGNED_OUT } = SIGNED_OUT;
const { panelRiseMs, slidePx, panelHeroDim } = tokens.motion;
const { xl } = tokens.radius;
const RESTING_TOP = 440; // the panel's top edge inside the content area, as laid out on the emulator
const TOP_INSET = 24; // helpers' METRICS status bar
const TRAVEL = RESTING_TOP + TOP_INSET;

type Animated = {
  opacity?: number;
  borderTopLeftRadius?: number;
  backgroundColor?: string;
  transform?: { translateY: number }[];
};
const animated = (testID: string): Animated =>
  (
    screen.getByTestId(testID, { includeHiddenElements: true }).props.jestAnimatedStyle as {
      value: Animated;
    }
  ).value;
const panelY = () => animated("welcome-actions").transform?.[0].translateY ?? 0;
const backdrop = () =>
  screen.getByTestId("system-bar-backdrop", { includeHiddenElements: true }).props
    .className as string;
// Mid-motion Welcome is hidden from assistive technology; these taps test touch handling.
const getStarted = () =>
  screen.getByRole("button", { name: "Get started", includeHiddenElements: true });
const advance = (ms: number) => act(async () => jest.advanceTimersByTime(ms));

/** Renders Welcome and lays the panel out, as the native side would. */
async function renderWelcome() {
  await renderInSafeArea(<WelcomeScreen />);
  await act(async () => {
    fireEvent(screen.getByTestId("welcome-actions", { includeHiddenElements: true }), "layout", {
      nativeEvent: { layout: { x: 0, y: RESTING_TOP, width: 320, height: 184 } },
    });
  });
}

/** The focus callback Welcome registered: what runs when it is focused again after a back. */
const refocus = () =>
  act(async () => {
    const [effect] = jest.mocked(useFocusEffect).mock.calls.at(-1) as [() => void];
    effect();
  });

beforeEach(() => {
  jest.useFakeTimers();
  // Shared with the destination at module level: every test starts with the panel at rest.
  panelProgress.value = 0;
  panelTravel.value = 0;
  jest.mocked(useSession).mockReturnValue(SESSION_SIGNED_OUT);
  jest.mocked(useReducedMotion).mockReturnValue(false);
  jest.mocked(router.push).mockReset();
  jest.mocked(useFocusEffect).mockClear();
  // The push normally moves focus away; a test that wants a push that did nothing says so.
  jest.mocked(useNavigation).mockReturnValue({ isFocused: () => false } as never);
});
afterEach(() => jest.useRealTimers());

describe("usePanelTransition (through WelcomeScreen)", () => {
  it("the tokens pace one purposeful motion", () => {
    expect(panelRiseMs).toBeGreaterThanOrEqual(350);
    expect(panelRiseMs).toBeLessThanOrEqual(450);
    expect(panelHeroDim).toBeGreaterThan(0);
    expect(panelHeroDim).toBeLessThan(1);
  });

  it("forward runs the rise then navigates once", async () => {
    await renderWelcome();
    expect(panelY()).toBeCloseTo(0, 5);
    expect(animated("welcome-actions").borderTopLeftRadius).toBe(xl);
    expect(backdrop()).toContain("bg-navy-900");

    await act(async () => fireEvent.press(getStarted()));
    expect(router.push).not.toHaveBeenCalled(); // the rise comes first

    await advance(panelRiseMs / 2);
    const midway = panelY();
    expect(midway).toBeLessThan(0);
    expect(midway).toBeGreaterThan(-TRAVEL);
    expect(animated("welcome-actions").borderTopLeftRadius).toBeLessThan(xl);
    expect(animated("welcome-hero").opacity).toBeLessThan(1); // dims and parallaxes
    expect(animated("welcome-hero").transform?.[0].translateY).toBeLessThan(0);

    await advance(panelRiseMs);
    expect(panelY()).toBeCloseTo(-TRAVEL, 0);
    expect(animated("welcome-actions").borderTopLeftRadius).toBeCloseTo(0, 0);
    expect(animated("welcome-hero").opacity).toBeCloseTo(panelHeroDim, 1);
    expect(animated("welcome-hero").transform?.[0].translateY).toBeCloseTo(-slidePx, 0);
    expect(backdrop()).toContain("bg-gray-50"); // the bar flipped as the panel covered it
    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith({
      pathname: "/(auth)/role",
      params: { from: "welcome" },
    });
  });

  it("the account link rises the same way into login", async () => {
    await renderWelcome();
    await act(async () =>
      fireEvent.press(
        screen.getByRole("button", {
          name: "I already have an account",
          includeHiddenElements: true,
        }),
      ),
    );
    await advance(panelRiseMs * 1.5);
    expect(router.push).toHaveBeenCalledWith({
      pathname: "/(auth)/login",
      params: { from: "welcome" },
    });
  });

  it("a second tap during the animation is ignored", async () => {
    await renderWelcome();
    await act(async () => fireEvent.press(getStarted()));
    await advance(panelRiseMs / 3);
    await act(async () => fireEvent.press(getStarted()));
    await act(async () =>
      fireEvent.press(
        screen.getByRole("button", {
          name: "I already have an account",
          includeHiddenElements: true,
        }),
      ),
    );
    await advance(panelRiseMs * 1.5);

    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith(expect.objectContaining({ pathname: "/(auth)/role" }));
  });

  it("back runs the reverse and restores the hero", async () => {
    await renderWelcome();
    await act(async () => fireEvent.press(getStarted()));
    await advance(panelRiseMs * 1.5);
    expect(panelY()).toBeCloseTo(-TRAVEL, 0);

    await refocus(); // the destination went away: Welcome is focused again
    await advance(panelRiseMs / 2);
    expect(panelY()).toBeGreaterThan(-TRAVEL);
    await advance(panelRiseMs);

    expect(panelY()).toBeCloseTo(0, 0);
    expect(animated("welcome-actions").borderTopLeftRadius).toBeCloseTo(xl, 0);
    expect(animated("welcome-hero").opacity).toBeCloseTo(1, 1);
    expect(animated("welcome-hero").transform?.[0].translateY).toBeCloseTo(0, 0);
    expect(backdrop()).toContain("bg-navy-900");

    await act(async () => fireEvent.press(getStarted())); // and it takes taps again
    await advance(panelRiseMs * 1.5);
    expect(router.push).toHaveBeenCalledTimes(2);
  });

  it("the actions take no taps until the panel is back down", async () => {
    await renderWelcome();
    await act(async () => fireEvent.press(getStarted()));
    await advance(panelRiseMs * 1.5);
    await refocus();

    await advance(panelRiseMs / 4); // lowering: the buttons are still invisible near the top
    await act(async () => fireEvent.press(getStarted()));
    await advance(panelRiseMs * 2);
    expect(router.push).toHaveBeenCalledTimes(1);
  });

  it("the status-bar strip beside the panel stays navy whichever way the bar flips", async () => {
    await renderWelcome();
    const strip = screen.getByTestId("welcome-bar-strip", { includeHiddenElements: true });
    expect(strip.props.className).toContain("bg-navy-900");
    expect(strip.props.style).toMatchObject({ top: -TOP_INSET, height: TOP_INSET });
  });

  it("the skirt tucks a corner radius under the panel, so no seam shows as they rise", async () => {
    await renderWelcome();
    const skirt = screen.getByTestId("welcome-actions-skirt", { includeHiddenElements: true }).props
      .style as object[];
    expect(skirt).toEqual(
      expect.arrayContaining([expect.objectContaining({ bottom: -TRAVEL, height: TRAVEL + xl })]),
    );
  });

  it("reduce motion uses a crossfade only: no rise, navigate at once", async () => {
    jest.mocked(useReducedMotion).mockReturnValue(true);
    await renderWelcome();

    await act(async () => fireEvent.press(getStarted()));

    expect(router.push).toHaveBeenCalledTimes(1);
    await advance(panelRiseMs);
    expect(panelY()).toBeCloseTo(0, 5);
    expect(animated("welcome-hero").opacity).toBe(1);
    expect(backdrop()).toContain("bg-navy-900");
  });

  it("navigation failure returns the panel to rest", async () => {
    jest.mocked(router.push).mockImplementation(() => {
      throw new Error("no such route");
    });
    await renderWelcome();
    await act(async () => fireEvent.press(getStarted()));
    await advance(panelRiseMs * 1.5);
    expect(router.push).toHaveBeenCalledTimes(1);

    await advance(panelRiseMs * 1.5); // the panel came back down
    expect(panelY()).toBeCloseTo(0, 0);
    expect(backdrop()).toContain("bg-navy-900");

    await act(async () => fireEvent.press(getStarted())); // and the user can try again
    await advance(panelRiseMs * 1.5);
    expect(router.push).toHaveBeenCalledTimes(2);
  });

  it("a push that leaves Welcome focused lowers the panel too", async () => {
    jest.mocked(useNavigation).mockReturnValue({ isFocused: () => true } as never);
    await renderWelcome();
    await act(async () => fireEvent.press(getStarted()));
    await advance(panelRiseMs * 1.5);
    expect(router.push).toHaveBeenCalledTimes(1);
    expect(panelY()).toBeCloseTo(-TRAVEL, 0);

    await advance(panelRiseMs * 2.5); // the settle check, then the lowering
    expect(panelY()).toBeCloseTo(0, 0);
  });
});

describe("the hand-off to the destination", () => {
  const { launchMaxMs } = tokens.motion;
  const TO_ROLE = { pathname: "/(auth)/role", params: { from: "welcome" } };
  const TO_LOGIN = { pathname: "/(auth)/login", params: { from: "welcome" } };

  beforeEach(() => {
    panelHandoffStore.setState({ phase: "idle", bar: "hero" });
    jest.mocked(router.prefetch).mockClear();
  });
  afterEach(() => jest.restoreAllMocks());

  it("publishes the panel's phase and bar: rising, the bar flipping as it covers it, then risen", async () => {
    await renderWelcome();
    await act(async () => fireEvent.press(getStarted()));
    expect(panelHandoffStore.getState()).toEqual({ phase: "rising", bar: "hero" });

    // Nearly settled: once the panel covers the status bar, the destination may start.
    await advance(panelRiseMs / 2);
    expect(panelHandoffStore.getState().phase).toBe("rising");
    let progressAtHandoff = 0;
    const unsubscribe = panelHandoffStore.subscribe((state) => {
      if (state.phase === "risen" && progressAtHandoff === 0)
        progressAtHandoff = -panelY() / TRAVEL;
    });

    await advance(panelRiseMs * 1.5);
    unsubscribe();
    expect(panelHandoffStore.getState()).toEqual({ phase: "risen", bar: "light" });
    expect(progressAtHandoff).toBeGreaterThan(0.95); // the strip covered, not the last frame
    expect(progressAtHandoff).toBeLessThan(1);

    await refocus(); // back: the panel lowers
    expect(panelHandoffStore.getState().phase).toBe("idle");
  });

  it("covered, Welcome leaves the accessibility tree; back at rest, it returns", async () => {
    const hero = () =>
      screen.queryByRole("header", { name: "Whatever happens at home, we fix it." });
    await renderWelcome();
    expect(hero()).toBeTruthy();

    await act(async () => fireEvent.press(getStarted()));
    await advance(panelRiseMs * 1.5);
    expect(hero()).toBeNull(); // the destination is the screen now, even where Welcome still paints
    expect(
      screen.getByTestId("welcome-body", { includeHiddenElements: true }).props
        .importantForAccessibility,
    ).toBe("no-hide-descendants");

    await refocus();
    await advance(panelRiseMs * 1.5);
    expect(hero()).toBeTruthy();
  });

  it("iOS: the destination is pushed when the panel has settled", async () => {
    await renderWelcome();
    await act(async () => fireEvent.press(getStarted()));
    await advance(panelRiseMs / 2);
    expect(router.push).not.toHaveBeenCalled();
    await advance(panelRiseMs);
    expect(router.push).toHaveBeenCalledTimes(1);
  });

  it("Android: the destination is pushed as the rise starts, to be on screen when it settles", async () => {
    jest.replaceProperty(Platform, "OS", "android");
    await renderWelcome();
    await act(async () => fireEvent.press(getStarted()));
    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith(TO_ROLE);
    expect(panelHandoffStore.getState().phase).toBe("rising");

    await advance(panelRiseMs * 1.5);
    expect(panelY()).toBeCloseTo(-TRAVEL, 0); // the rise still runs to the top
    expect(panelHandoffStore.getState().phase).toBe("risen");
    expect(router.push).toHaveBeenCalledTimes(1);
  });

  it("Android: a push that throws lowers the panel that already started", async () => {
    jest.replaceProperty(Platform, "OS", "android");
    jest.mocked(router.push).mockImplementation(() => {
      throw new Error("no such route");
    });
    await renderWelcome();
    await act(async () => fireEvent.press(getStarted()));
    await advance(panelRiseMs * 2);
    expect(panelY()).toBeCloseTo(0, 0);
    expect(panelHandoffStore.getState().phase).toBe("idle");
  });

  it("Reduce Motion: no rise, the panel counts as risen at once", async () => {
    jest.mocked(useReducedMotion).mockReturnValue(true);
    await renderWelcome();
    await act(async () => fireEvent.press(getStarted()));
    expect(panelHandoffStore.getState()).toEqual({ phase: "risen", bar: "hero" });
    expect(router.push).toHaveBeenCalledTimes(1);
  });

  it("prefetches both ways in after the launch intro; after a round trip, only the one used", async () => {
    await renderWelcome();

    await refocus(); // the first focus, under the launch intro
    expect(router.prefetch).not.toHaveBeenCalled();
    await advance(launchMaxMs);
    expect(jest.mocked(router.prefetch).mock.calls).toEqual([[TO_ROLE], [TO_LOGIN]]);

    jest.mocked(router.prefetch).mockClear();
    await act(async () => fireEvent.press(getStarted()));
    await advance(panelRiseMs * 1.5);
    expect(router.prefetch).not.toHaveBeenCalled(); // busy: rising, then covered

    await refocus(); // back: the panel lowers, then the screen it used is built again
    expect(router.prefetch).not.toHaveBeenCalled();
    await advance(panelRiseMs * 1.5);
    // Login is still prefetched: building it anew would throw it away and rebuild it.
    expect(jest.mocked(router.prefetch).mock.calls).toEqual([[TO_ROLE]]);
  });
});
