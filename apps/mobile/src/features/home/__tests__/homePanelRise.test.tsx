import "@/i18n";

import { act, fireEvent, screen } from "@testing-library/react-native";
import { router, useFocusEffect, useNavigation } from "expo-router";
import { Platform } from "react-native";
import { useReducedMotion } from "react-native-reanimated";

import { apiGet, useSession } from "@/api";
import { createPanelHandoff, type PanelHandoff } from "@/features/auth";
import { requestDraftStore } from "@/features/request";
import { tokens } from "@/theme";

import { CustomerHomeScreen } from "../CustomerHomeScreen";
import { CATEGORIES, renderWithQuery, signedIn } from "./helpers";

jest.mock("@/api", () => ({
  ...jest.requireActual("../../../api/errors"),
  onSignOut: jest.fn(),
  apiGet: jest.fn(),
  useSession: jest.fn(),
}));
jest.mock("expo-router", () => ({
  router: { push: jest.fn(), prefetch: jest.fn() },
  useIsFocused: () => true,
  useScrollToTop: jest.fn(),
  useFocusEffect: jest.fn(),
  useNavigation: jest.fn(),
  unstable_useIsNavigating: () => false,
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

const FIRST_STEP = "/request/new";
const { panelRiseMs, panelHeroDim } = tokens.motion;
const { xl } = tokens.radius;
const PANEL_Y = 300; // the categories panel's top in the scroll content
const TOP_INSET = 24; // helpers' METRICS status bar

type Animated = {
  opacity?: number;
  borderTopLeftRadius?: number;
  transform?: { translateY: number }[];
};
const animated = (testID: string): Animated =>
  (
    screen.getByTestId(testID, { includeHiddenElements: true }).props.jestAnimatedStyle as {
      value: Animated;
    }
  ).value;
const panelTranslate = () => animated("home-categories").transform?.[0].translateY ?? 0;
const card = (name: string) => screen.getByRole("button", { name, includeHiddenElements: true });
const advance = (ms: number) => act(async () => jest.advanceTimersByTime(ms));

let handoff: PanelHandoff;

/** Renders Home with its categories and lays the panel out at `PANEL_Y`, scrolled by `scrollY`. */
async function renderHome(scrollY = 0) {
  await renderWithQuery(<CustomerHomeScreen />, undefined, handoff);
  await act(async () => jest.advanceTimersByTime(0));
  await act(async () => {
    fireEvent(screen.getByTestId("home-categories"), "layout", {
      nativeEvent: { layout: { x: 0, y: PANEL_Y, width: 320, height: 600 } },
    });
    fireEvent.scroll(screen.getByTestId("customer-home-scroll"), {
      nativeEvent: { contentOffset: { x: 0, y: scrollY } },
    });
  });
}

/** The focus callback Home registered: what runs when it is focused again after the flow. */
const refocus = () =>
  act(async () => {
    const [effect] = jest.mocked(useFocusEffect).mock.calls.at(-1) as [() => void];
    effect();
  });

beforeEach(() => {
  jest.useFakeTimers();
  handoff = createPanelHandoff();
  jest.mocked(useSession).mockReturnValue(signedIn());
  jest.mocked(apiGet).mockReset().mockResolvedValue(CATEGORIES);
  jest.mocked(useReducedMotion).mockReturnValue(false);
  jest.mocked(router.push).mockReset();
  jest.mocked(router.prefetch).mockReset();
  jest.mocked(useFocusEffect).mockClear();
  // The push moves focus to the flow.
  jest.mocked(useNavigation).mockReturnValue({ isFocused: () => false } as never);
  requestDraftStore.setState({ categorySlug: null });
});
afterEach(() => {
  jest.useRealTimers();
  Platform.OS = "ios";
});

describe("Home's categories panel rises into the request", () => {
  it("covers the screen from where it sits, as the hero dims and the cards fade", async () => {
    await renderHome();
    expect(panelTranslate()).toBeCloseTo(0, 0);

    await act(async () => fireEvent.press(card("Painting")));
    await advance(panelRiseMs * 1.5);

    // Up by its own top and the status-bar strip: its top edge is the screen's.
    expect(panelTranslate()).toBeCloseTo(-(PANEL_Y + TOP_INSET), 0);
    expect(animated("home-categories").borderTopLeftRadius).toBeCloseTo(0, 1);
    expect(animated("home-categories-content").opacity).toBeCloseTo(0, 1);
    expect(animated("customer-home-hero").opacity).toBeCloseTo(panelHeroDim, 1);
    expect(handoff.store.getState()).toEqual({ phase: "risen", bar: "light" });
    expect(router.push).toHaveBeenCalledWith(FIRST_STEP);
    expect(requestDraftStore.getState().categorySlug).toBe("painting");
    // The skirt, the page's color, covers what the panel leaves at the bottom of the screen.
    expect(
      screen.getByTestId("home-categories-skirt", { includeHiddenElements: true }),
    ).toBeTruthy();
  });

  it("starts from the panel's top on screen when the page is scrolled", async () => {
    await renderHome(120);

    await act(async () => fireEvent.press(card("Painting")));
    await advance(panelRiseMs * 1.5);

    expect(panelTranslate()).toBeCloseTo(-(PANEL_Y - 120 + TOP_INSET), 0);
  });

  it("lowers again when the flow is left, and builds nothing ahead", async () => {
    await renderHome();
    await act(async () => fireEvent.press(card("Painting")));
    await advance(panelRiseMs * 1.5);

    await refocus(); // the flow went away: Home is focused again
    await advance(panelRiseMs * 1.5);

    expect(panelTranslate()).toBeCloseTo(0, 0);
    expect(animated("home-categories").borderTopLeftRadius).toBeCloseTo(xl, 0);
    expect(animated("home-categories-content").opacity).toBeCloseTo(1, 1);
    expect(animated("customer-home-hero").opacity).toBeCloseTo(1, 1);
    expect(handoff.store.getState().phase).toBe("idle");
    expect(card("Handyman")).not.toBeDisabled();
    expect(screen.getByTestId("customer-home-scroll").props.pointerEvents).toBe("auto");
    // Home prefetches no request: the flow is built for the category tapped.
    expect(router.prefetch).not.toHaveBeenCalled();
  });

  it("Android: the first step is pushed as the rise starts, to ride the panel", async () => {
    Platform.OS = "android";
    await renderHome();

    await act(async () => fireEvent.press(card("Painting")));

    expect(router.push).toHaveBeenCalledWith(FIRST_STEP);
    expect(requestDraftStore.getState().categorySlug).toBe("painting");
  });

  it("Reduce Motion: no rise, the request opens at once", async () => {
    jest.mocked(useReducedMotion).mockReturnValue(true);
    await renderHome();

    await act(async () => fireEvent.press(card("Painting")));

    expect(router.push).toHaveBeenCalledWith(FIRST_STEP);
    expect(panelTranslate()).toBeCloseTo(0, 0);
  });
});
