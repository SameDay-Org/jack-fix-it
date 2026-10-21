import "@/i18n";

import { act, fireEvent, renderRouter, screen } from "expo-router/testing-library";
import { router } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { createElement } from "react";
import { Text } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { logout, restoreSession, useSession } from "@/api";

import { user } from "../../../api/__tests__/helpers";
import AppLayout from "../../../app/(app)/_layout";
import AuthLayout, { unstable_settings } from "../../../app/(auth)/_layout";
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
  "(app)/_layout": AppLayout,
  "(app)/index": () => <Text>app stub</Text>,
};

beforeEach(() => {
  jest.mocked(SplashScreen.hideAsync).mockClear();
  jest.mocked(logout).mockClear();
  jest.mocked(restoreSession).mockClear();
});

describe("session gate", () => {
  it("restoring shows the static launch frame and routes nowhere yet", async () => {
    session({ status: "restoring" });

    await renderRouter(routes);

    expect(screen.getByTestId("restoring-hero")).toBeTruthy();
    expect(screen.getByText("fix").props.className).toContain("text-green-500");
    expect(SplashScreen.hideAsync).not.toHaveBeenCalled(); // the launch intro owns the splash
    expect(screen.queryByText("welcome stub")).toBeNull();
    expect(screen.queryByText("app stub")).toBeNull();
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
