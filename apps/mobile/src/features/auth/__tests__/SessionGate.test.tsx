import "@/i18n";

import { act, fireEvent, renderRouter, screen } from "expo-router/testing-library";
import { router, Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { type ComponentProps, createElement } from "react";
import { Text } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { logout, restoreSession, useSession } from "@/api";
import { tokens } from "@/theme";

import { user } from "../../../api/__tests__/helpers";
import AppLayout, { unstable_settings as appSettings } from "../../../app/(app)/_layout";
import { phoneFlowStore } from "../../phone/phoneFlow";
import AuthLayout, { unstable_settings } from "../../../app/(auth)/_layout";
import { TabsLayout } from "../../tabs/TabsLayout";
import { HomePlaceholderScreen } from "../HomePlaceholderScreen";
import { SessionGate } from "../SessionGate";
import { METRICS, SIGNED_OUT } from "./helpers";

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
// Every stack renders through a recording wrapper, so a navigator's options can be asserted.
jest.mock("expo-router", () => {
  const actual = jest.requireActual<typeof import("expo-router")>("expo-router");
  const { createElement: h } = jest.requireActual<typeof import("react")>("react");
  const Stack = Object.assign(
    jest.fn((props: ComponentProps<typeof actual.Stack>) => h(actual.Stack, props)),
    { Screen: actual.Stack.Screen, Protected: actual.Stack.Protected },
  );
  return { ...actual, Stack };
});
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);

type Session = ReturnType<typeof useSession>;
const { accessToken: _a, accessTokenExpiresAt: _b, ...SESSION_SIGNED_OUT } = SIGNED_OUT;

const session = (overrides: Partial<Session>) =>
  jest.mocked(useSession).mockReturnValue({ ...SESSION_SIGNED_OUT, ...overrides });

const routes = {
  _layout: () =>
    createElement(SafeAreaProvider, { initialMetrics: METRICS }, createElement(SessionGate)),
  "(auth)/_layout": { default: AuthLayout, unstable_settings },
  "(auth)/welcome": () => <Text>welcome stub</Text>,
  "(app)/_layout": { default: AppLayout, unstable_settings: appSettings },
  "(app)/(tabs)/_layout": TabsLayout,
  "(app)/(tabs)/index": () => <Text>app stub</Text>,
  "(app)/verify-phone/index": () => <Text>phone step stub</Text>,
};

beforeEach(() => {
  jest.mocked(SplashScreen.hideAsync).mockClear();
  jest.mocked(logout).mockClear();
  jest.mocked(restoreSession).mockClear();
  jest.mocked(Stack).mockClear();
  phoneFlowStore.setState({ pendingNumber: null, offeredAfterSignUp: false });
});

describe("session gate", () => {
  it("restoring shows the static launch frame and routes nowhere yet", async () => {
    session({ status: "restoring" });

    await renderRouter(routes);

    expect(screen.getByTestId("restoring-hero")).toBeTruthy();
    expect(
      screen.getAllByText("fix", { includeHiddenElements: true })[0].props.className,
    ).toContain("text-green-500");
    expect(SplashScreen.hideAsync).not.toHaveBeenCalled(); // the launch intro owns the splash
    expect(screen.queryByText("welcome stub")).toBeNull();
    expect(screen.queryByText("app stub")).toBeNull();
  });

  it("paints navy under a group while its first screen mounts", async () => {
    session({ status: "signedOut" });

    await renderRouter(routes);

    // The gate's stack is the one with a content style; the groups' own stacks keep the default.
    const options = jest.mocked(Stack).mock.calls.map(([props]) => props.screenOptions);
    expect(options).toContainEqual(
      expect.objectContaining({ contentStyle: { backgroundColor: tokens.colors["navy-900"] } }),
    );
  });

  it("signedOut routes to welcome", async () => {
    session({ status: "signedOut" });

    const result = await renderRouter(routes);

    expect(result.getPathname()).toBe("/welcome");
    expect(screen.getByText("welcome stub")).toBeTruthy();
  });

  it("signedIn routes to app", async () => {
    session({ status: "signedIn", user });

    const result = await renderRouter(routes);

    expect(result.getPathname()).toBe("/");
    expect(screen.getByText("app stub")).toBeTruthy();
  });

  it("a sign-up opens the phone step over home, so Skip and Back end on home", async () => {
    phoneFlowStore.setState({ offeredAfterSignUp: true });
    session({ status: "signedIn", user });

    // Signed in while on an auth screen: the auth guard sends the session home, and home opens
    // the phone step over itself.
    const result = await renderRouter(
      { ...routes, "(app)/(tabs)/index": HomePlaceholderScreen },
      { initialUrl: "/welcome" },
    );

    expect(result.getPathname()).toBe("/verify-phone");
    expect(result.getSearchParams()).toEqual({ from: "sign-up" });
    expect(screen.getByText("phone step stub")).toBeTruthy();

    await act(async () => phoneFlowStore.setState({ offeredAfterSignUp: false })); // shown once
    await act(async () => router.back());
    expect(result.getPathname()).toBe("/");
    expect(screen.getByRole("button", { name: "Verify your phone" })).toBeTruthy();
  });

  it("any other sign-in lands on home", async () => {
    session({ status: "signedIn", user });

    const result = await renderRouter(routes, { initialUrl: "/welcome" });

    expect(result.getPathname()).toBe("/");
    expect(screen.queryByText("phone step stub")).toBeNull();
  });

  it("deep link to app while signed out lands on welcome", async () => {
    session({ status: "signedOut" });

    const result = await renderRouter(routes, { initialUrl: "/" });
    expect(result.getPathname()).toBe("/welcome");

    await act(async () => router.push("/"));
    expect(result.getPathname()).toBe("/welcome");
    expect(screen.queryByText("app stub")).toBeNull();
  });

  it("a restore that could not reach the server shows the offline screen with retry and another account", async () => {
    session({ status: "signedOut", restoreFailure: "offline" });

    await renderRouter(routes);

    expect(screen.getByText("Can't reach Jack right now")).toBeTruthy();
    expect(screen.queryByText("welcome stub")).toBeNull();

    await fireEvent.press(screen.getByRole("button", { name: "Try again" }));
    expect(restoreSession).toHaveBeenCalledTimes(1);

    await fireEvent.press(screen.getByRole("button", { name: "Log in with another account" }));
    expect(logout).toHaveBeenCalledTimes(1);
  });
});
