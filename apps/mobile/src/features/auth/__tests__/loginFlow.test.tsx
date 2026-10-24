import "@/i18n";

import { fireEvent, renderRouter, screen, waitFor } from "expo-router/testing-library";
import { createElement } from "react";
import { Text } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { attachQueryClient, sessionStore } from "@/api/session";
import { QueryClient } from "@tanstack/react-query";

import {
  authResponse,
  errorResponse,
  installFetchMock,
  jsonResponse,
  resetSecureStore,
  type FetchMock,
} from "../../../api/__tests__/helpers";
import AppLayout from "../../../app/(app)/_layout";
import AuthLayout, { unstable_settings } from "../../../app/(auth)/_layout";
import { LoginScreen } from "../LoginScreen";
import { SessionGate } from "../SessionGate";
import { METRICS, SIGNED_OUT } from "./helpers";

jest.mock(
  "../../../api/config",
  () => jest.requireActual("../../../api/__tests__/helpers").configMock,
);
jest.mock(
  "expo-secure-store",
  () => jest.requireActual("../../../api/__tests__/helpers").secureStoreMock,
);
jest.mock("expo-splash-screen", () => ({
  preventAutoHideAsync: jest.fn(async () => true),
  hideAsync: jest.fn(async () => true),
}));
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);

// The real gate and the real login screen inside the real route groups; the other screens are stubs.
const routes = {
  _layout: () =>
    createElement(SafeAreaProvider, { initialMetrics: METRICS }, createElement(SessionGate)),
  "(auth)/_layout": { default: AuthLayout, unstable_settings },
  "(auth)/welcome": () => <Text>welcome stub</Text>,
  "(auth)/login": LoginScreen,
  "(app)/_layout": AppLayout,
  "(app)/index": () => <Text>app stub</Text>,
};

let fetchMock: FetchMock;

beforeEach(() => {
  fetchMock = installFetchMock();
  resetSecureStore();
  // gcTime Infinity: no garbage-collection timer, so Jest exits once the tests are done.
  attachQueryClient(new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } }));
  sessionStore.setState(SIGNED_OUT);
});

describe("login flow", () => {
  it("success routes to app", async () => {
    fetchMock.mockImplementation(async (url) =>
      new URL(url).pathname === "/v1/auth/login"
        ? jsonResponse(200, authResponse(1))
        : errorResponse(404, "not_found"),
    );
    const result = await renderRouter(routes, { initialUrl: "/login" });
    expect(result.getPathname()).toBe("/login");

    await fireEvent.changeText(screen.getByLabelText("Email"), "maria@example.com");
    await fireEvent.changeText(screen.getByLabelText("Password"), "correct horse battery");
    await fireEvent.press(screen.getByRole("button", { name: "Log in" }));

    await waitFor(() => expect(result.getPathname()).toBe("/"));
    expect(screen.getByText("app stub")).toBeTruthy();
    expect(sessionStore.getState()).toMatchObject({ status: "signedIn", accessToken: "access-1" });
  });

  it("a rejected login stays on the screen with the message", async () => {
    fetchMock.mockResolvedValue(errorResponse(401, "invalid_credentials"));
    const result = await renderRouter(routes, { initialUrl: "/login" });

    await fireEvent.changeText(screen.getByLabelText("Email"), "maria@example.com");
    await fireEvent.changeText(screen.getByLabelText("Password"), "correct horse battery");
    await fireEvent.press(screen.getByRole("button", { name: "Log in" }));

    expect(await screen.findByText("Email or password is incorrect.")).toBeTruthy();
    expect(result.getPathname()).toBe("/login");
    expect(sessionStore.getState().status).toBe("signedOut");
  });
});
