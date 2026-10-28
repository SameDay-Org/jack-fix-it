import "@/i18n";

import { act, renderRouter } from "expo-router/testing-library";
import { createElement, Profiler, useLayoutEffect } from "react";
import { Text } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { user } from "../../../api/__tests__/helpers";
import AppLayout, { unstable_settings as appSettings } from "../../../app/(app)/_layout";
import AuthLayout, { unstable_settings } from "../../../app/(auth)/_layout";
import { SessionGate } from "../SessionGate";
import { METRICS, SIGNED_OUT } from "./helpers";

// A session that changes under the mounted router, as a sign-in and a sign-out do.
const { accessToken: _a, accessTokenExpiresAt: _b, ...SESSION_SIGNED_OUT } = SIGNED_OUT;
type MockSession = ReturnType<typeof import("@/api").useSession>;
const SESSION_SIGNED_IN: MockSession = { ...SESSION_SIGNED_OUT, status: "signedIn", user };
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
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);

// Which screens are mounted, as of each commit under the gate. A screen's layout effect runs in
// the commit that mounts it and its cleanup in the one that removes it, both before the
// Profiler's `onRender` for that commit, so each entry is what that commit puts on screen.
const mounted = new Set<string>();
let commits: string[][] = [];
function Marker({ name }: { name: string }) {
  useLayoutEffect(() => {
    mounted.add(name);
    return () => {
      mounted.delete(name);
    };
  }, [name]);
  return <Text>{name}</Text>;
}

const routes = {
  _layout: () =>
    createElement(
      SafeAreaProvider,
      { initialMetrics: METRICS },
      createElement(
        Profiler,
        { id: "gate", onRender: () => commits.push([...mounted].sort()) },
        createElement(SessionGate),
      ),
    ),
  "(auth)/_layout": { default: AuthLayout, unstable_settings },
  "(auth)/welcome": () => <Marker name="welcome" />,
  "(auth)/login": () => <Marker name="login" />,
  "(app)/_layout": { default: AppLayout, unstable_settings: appSettings },
  "(app)/index": () => <Marker name="home" />,
};

beforeEach(() => {
  mounted.clear();
  commits = [];
});

describe("the session gate switching groups (#177)", () => {
  it("a sign-out mounts Welcome in the commit that takes home away: no commit shows neither", async () => {
    mockSession.state = SESSION_SIGNED_IN;
    const result = await renderRouter(routes, { initialUrl: "/" });
    expect(result.getPathname()).toBe("/");
    commits = [];

    await act(async () => mockSession.set(SESSION_SIGNED_OUT));

    expect(result.getPathname()).toBe("/welcome");
    expect(commits.length).toBeGreaterThan(0);
    // Before #177 the guarded home turned into a redirect that renders nothing, and Welcome came
    // a few commits later: those commits held no screen at all (plain navy on the device).
    expect(commits).not.toContainEqual([]);
    expect(commits.at(-1)).toEqual(["welcome"]);
  });

  it("leaving the offline screen for another account mounts Welcome in the same commit", async () => {
    // A restore that could not reach the server: the groups are not mounted yet, and the router
    // still has the launch URL's group focused.
    mockSession.state = { ...SESSION_SIGNED_OUT, restoreFailure: "offline" };
    const result = await renderRouter(routes, { initialUrl: "/" });
    commits = [];

    await act(async () => mockSession.set(SESSION_SIGNED_OUT)); // "Log in with another account"

    expect(result.getPathname()).toBe("/welcome");
    expect(commits.length).toBeGreaterThan(0);
    expect(commits).not.toContainEqual([]);
    expect(commits.at(-1)).toEqual(["welcome"]);
  });

  it("a sign-in mounts home in the commit that takes the auth screen away", async () => {
    mockSession.state = SESSION_SIGNED_OUT;
    const result = await renderRouter(routes, { initialUrl: "/login" });
    expect(result.getPathname()).toBe("/login");
    commits = [];

    await act(async () => mockSession.set(SESSION_SIGNED_IN));

    expect(result.getPathname()).toBe("/");
    expect(commits).not.toContainEqual([]);
    expect(commits.at(-1)).toEqual(["home"]);
  });
});
