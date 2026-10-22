import "@/i18n";

import { act, fireEvent, renderRouter, screen } from "expo-router/testing-library";
import { createElement } from "react";
import { Text } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { tokens } from "@/theme";

import { user } from "../../../api/__tests__/helpers";
import AppLayout from "../../../app/(app)/_layout";
import AuthLayout, { unstable_settings } from "../../../app/(auth)/_layout";
import { SessionGate } from "../SessionGate";
import { WelcomeScreen } from "../WelcomeScreen";
import { METRICS, SIGNED_OUT } from "./helpers";

// A session that changes under the mounted router, as a sign-in and a sign-out do.
const { accessToken: _a, accessTokenExpiresAt: _b, ...SESSION_SIGNED_OUT } = SIGNED_OUT;
type MockSession = ReturnType<typeof import("@/api").useSession>;
const mockSession = {
  state: SESSION_SIGNED_OUT as MockSession,
  listeners: new Set<() => void>(),
  set(next: MockSession) {
    this.state = next;
    this.listeners.forEach((listener) => listener());
  },
};

jest.mock("@/api", () => {
  const { useSyncExternalStore } = jest.requireActual<typeof import("react")>("react");
  return {
    useSession: () =>
      useSyncExternalStore(
        (listener: () => void) => {
          mockSession.listeners.add(listener);
          return () => mockSession.listeners.delete(listener);
        },
        () => mockSession.state,
      ),
    logout: jest.fn(async () => undefined),
    restoreSession: jest.fn(async () => undefined),
  };
});
jest.mock("expo-splash-screen", () => ({
  preventAutoHideAsync: jest.fn(async () => true),
  hideAsync: jest.fn(async () => true),
}));
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);

const { panelRiseMs } = tokens.motion;
const routes = {
  _layout: () =>
    createElement(SafeAreaProvider, { initialMetrics: METRICS }, createElement(SessionGate)),
  "(auth)/_layout": { default: AuthLayout, unstable_settings },
  "(auth)/welcome": WelcomeScreen,
  "(auth)/login": () => <Text>login stub</Text>,
  "(auth)/role": () => <Text>role stub</Text>,
  "(app)/_layout": AppLayout,
  "(app)/index": () => <Text>app stub</Text>,
};
const advance = (ms: number) => act(async () => jest.advanceTimersByTime(ms));
beforeEach(() => {
  jest.useFakeTimers();
  mockSession.state = SESSION_SIGNED_OUT;
});
afterEach(() => jest.useRealTimers());

describe("Welcome after a sign-in and a sign-out (#175 round 2)", () => {
  it("comes back at rest and takes the way in again", async () => {
    const result = await renderRouter(routes, { initialUrl: "/welcome" });
    await advance(panelRiseMs);

    // The panel rises into Login.
    await act(async () =>
      fireEvent.press(
        screen.getByRole("button", {
          name: "I already have an account",
          includeHiddenElements: true,
        }),
      ),
    );
    await advance(panelRiseMs * 2);
    expect(result.getPathname()).toBe("/login");

    // A sign-in removes the whole auth group: no back, no refocus of Welcome.
    await act(async () => mockSession.set({ ...SESSION_SIGNED_OUT, status: "signedIn", user }));
    expect(result.getPathname()).toBe("/");
    expect(screen.getByText("app stub")).toBeTruthy();

    // A sign-out mounts the group again: Welcome at rest, its actions on screen and reachable.
    await act(async () => mockSession.set(SESSION_SIGNED_OUT));
    await advance(panelRiseMs * 2);
    expect(result.getPathname()).toBe("/welcome");
    // (The panel's rest values are asserted under the real Reanimated in usePanelTransition.test;
    // here, with expo-router's Reanimated mock, what counts is that Welcome is usable again.)
    const getStarted = screen.getByRole("button", { name: "Get started" }); // not hidden: reachable
    await act(async () => fireEvent.press(getStarted));
    await advance(panelRiseMs * 2);
    expect(result.getPathname()).toBe("/role");
  });
});
