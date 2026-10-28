import "@/i18n";

import { act, renderRouter, screen } from "expo-router/testing-library";
import { createElement, Profiler, useLayoutEffect, useState } from "react";
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
// `lifecycle` numbers each screen instance, so a screen that is torn down and built again shows.
const mounted = new Set<string>();
const lifecycle: string[] = [];
let instances = 0;
let commits: string[][] = [];
function Marker({ name }: { name: string }) {
  const [instance] = useState(() => ++instances);
  useLayoutEffect(() => {
    mounted.add(name);
    lifecycle.push(`${name} ${instance} mount`);
    return () => {
      mounted.delete(name);
      lifecycle.push(`${name} ${instance} unmount`);
    };
  }, [name, instance]);
  return <Text>{name}</Text>;
}

// The (app) layout's session shell, what that group holds in a commit without a signed-in
// session (#205). It is hidden from accessibility, so the query must include hidden elements.
function shellShown(): boolean {
  try {
    return screen.queryByTestId("session-shell", { includeHiddenElements: true }) !== null;
  } catch {
    return false; // the router's first commit: the testing library has no screen yet
  }
}

const routes = {
  _layout: () =>
    createElement(
      SafeAreaProvider,
      { initialMetrics: METRICS },
      createElement(
        Profiler,
        {
          id: "gate",
          onRender: () => commits.push([...mounted, ...(shellShown() ? ["shell"] : [])].sort()),
        },
        createElement(SessionGate),
      ),
    ),
  "(auth)/_layout": { default: AuthLayout, unstable_settings },
  "(auth)/welcome": () => <Marker name="welcome" />,
  "(auth)/login": () => <Marker name="login" />,
  "(app)/_layout": { default: AppLayout, unstable_settings: appSettings },
  "(app)/index": () => <Marker name="home" />,
};

afterEach(() => jest.restoreAllMocks());

beforeEach(() => {
  mounted.clear();
  lifecycle.length = 0;
  instances = 0;
  commits = [];
});

describe("the session gate switching groups (#177)", () => {
  it("a sign-out mounts Welcome in the commit that takes home away: no commit shows neither", async () => {
    mockSession.state = SESSION_SIGNED_IN;
    const result = await renderRouter(routes, { initialUrl: "/" });
    expect(result.getPathname()).toBe("/");
    expect(lifecycle).toEqual(["home 1 mount"]);
    commits = [];

    await act(async () => mockSession.set(SESSION_SIGNED_OUT));

    expect(result.getPathname()).toBe("/welcome");
    expect(commits.length).toBeGreaterThan(0);
    // Before #177 the guarded home turned into a redirect that renders nothing, and Welcome came
    // a few commits later: those commits held no screen at all (plain navy on the device). The
    // commit that drops home now holds the (app) layout's shell (#205); it is never drawn, since
    // the replace from the gate's layout effect lands in the next commit, before paint.
    expect(commits).not.toContainEqual([]);
    expect(commits[0]).toEqual(["shell"]);
    expect(commits.at(-1)).toEqual(["welcome"]);
    // One Welcome, built once: a second replace would tear it down and build another.
    expect(lifecycle).toEqual(["home 1 mount", "home 1 unmount", "welcome 2 mount"]);
  });

  it.each([
    ["in the same update", false],
    ["in a later update", true],
  ])(
    "Welcome survives a second signed-out notification %s (the session's cleanup)",
    async (_when, later) => {
      mockSession.state = SESSION_SIGNED_IN;
      const result = await renderRouter(routes, { initialUrl: "/" });

      await act(async () => {
        mockSession.set(SESSION_SIGNED_OUT);
        if (!later) mockSession.set({ ...SESSION_SIGNED_OUT, cleanupPending: true });
      });
      // Once the switch has landed, a new snapshot of the same session leaves the gate's effect
      // alone; these cases pin that, whatever the effect comes to depend on.
      if (later) {
        await act(async () => mockSession.set({ ...SESSION_SIGNED_OUT, cleanupPending: true }));
      }
      await act(async () => mockSession.set(SESSION_SIGNED_OUT));

      expect(result.getPathname()).toBe("/welcome");
      expect(lifecycle).toEqual(["home 1 mount", "home 1 unmount", "welcome 2 mount"]);
    },
  );

  it("leaving the offline screen for another account mounts Welcome in the next commit, once", async () => {
    // A restore that could not reach the server: the groups are not mounted yet, and the router
    // still has the launch URL's group focused.
    mockSession.state = { ...SESSION_SIGNED_OUT, restoreFailure: "offline" };
    const result = await renderRouter(routes, { initialUrl: "/" });
    commits = [];

    await act(async () => mockSession.set(SESSION_SIGNED_OUT)); // "Log in with another account"

    expect(result.getPathname()).toBe("/welcome");
    // The commit that mounts the groups guards the focused one (its redirect renders nothing);
    // the replace from its layout effect is the very next commit, before that one is drawn.
    // Before #177 the redirect's own replace landed two commits later.
    expect(commits.slice(0, 2)).toEqual([[], ["welcome"]]);
    expect(lifecycle).toEqual(["welcome 1 mount"]); // the redirect's queued replace does not remount it
  });

  it("a sign-in mounts home in the commit that takes the auth screen away, once", async () => {
    mockSession.state = SESSION_SIGNED_OUT;
    const result = await renderRouter(routes, { initialUrl: "/login" });
    expect(result.getPathname()).toBe("/login");
    expect(lifecycle).toEqual(["welcome 1 mount", "login 2 mount"]); // Welcome is under Login
    lifecycle.length = 0;
    commits = [];

    await act(async () => mockSession.set(SESSION_SIGNED_IN));
    await act(async () => mockSession.set({ ...SESSION_SIGNED_IN })); // a later snapshot, same group

    expect(result.getPathname()).toBe("/");
    expect(commits).not.toContainEqual([]);
    expect(commits.at(-1)).toEqual(["home"]);
    expect(lifecycle).toEqual(["welcome 1 unmount", "login 2 unmount", "home 3 mount"]);
  });

  it.each([
    ["signed out", SESSION_SIGNED_OUT, "/welcome", ["welcome 1 mount"]],
    ["signed in", SESSION_SIGNED_IN, "/", ["home 1 mount"]],
  ])(
    // An app launch passes through `restoring` first, so its gate mounts after the router does;
    // here the session is known in the router's first commit.
    "a session %s at the router's first commit reads no navigation state before the router has it",
    async (_status, session, pathname, expected) => {
      const error = jest.spyOn(console, "error");
      mockSession.state = session;

      const result = await renderRouter(routes, { initialUrl: "/" });

      expect(result.getPathname()).toBe(pathname);
      expect(lifecycle).toEqual(expected); // the guards still come from the session
      expect(error).not.toHaveBeenCalledWith(expect.stringContaining("hasn't been initialized"));
    },
  );
});
