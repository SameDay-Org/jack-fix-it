import "@/i18n";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, renderRouter, screen, waitFor } from "expo-router/testing-library";
import { router } from "expo-router";
import { createElement } from "react";
import { Text } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { apiGet, useSession, type SessionUser } from "@/api";

import { user } from "../../../api/__tests__/helpers";
import AppLayout, { unstable_settings as appSettings } from "../../../app/(app)/_layout";
import OpportunityRoute from "../../../app/(app)/opportunities/[id]";
import AuthLayout, { unstable_settings } from "../../../app/(auth)/_layout";
import { METRICS, SIGNED_OUT } from "../../auth/__tests__/helpers";
import { SessionGate } from "../../auth/SessionGate";
import { detail, DISPATCH_ID } from "./helpers";

type Session = ReturnType<typeof useSession>;

// The session the gate reads, changed by a test inside `act` (the restore landing).
const { accessToken: _a, accessTokenExpiresAt: _b, ...SESSION_SIGNED_OUT } = SIGNED_OUT;
const RESTORING: Session = { ...SESSION_SIGNED_OUT, status: "restoring" };
const mockSession = { current: RESTORING, listeners: new Set<() => void>() };

function setSession(next: Partial<Session>): void {
  mockSession.current = { ...mockSession.current, ...next };
  mockSession.listeners.forEach((listener) => listener());
}

jest.mock("@/api", () => {
  const { useSyncExternalStore } = jest.requireActual<typeof import("react")>("react");
  return {
    ...jest.requireActual("../../../api/errors"),
    apiGet: jest.fn(),
    logout: jest.fn(async () => undefined),
    restoreSession: jest.fn(async () => undefined),
    useSession: () =>
      useSyncExternalStore(
        (listener: () => void) => {
          mockSession.listeners.add(listener);
          return () => mockSession.listeners.delete(listener);
        },
        () => mockSession.current,
      ),
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

const LINK = `/opportunities/${DISPATCH_ID}`;
const PRO: SessionUser = { ...user, role: "pro", first_name: "Dan" };

let client: QueryClient;

const routes = {
  _layout: () =>
    createElement(
      SafeAreaProvider,
      { initialMetrics: METRICS },
      createElement(QueryClientProvider, { client }, createElement(SessionGate)),
    ),
  "(auth)/_layout": { default: AuthLayout, unstable_settings },
  "(auth)/welcome": () => <Text>welcome stub</Text>,
  "(app)/_layout": { default: AppLayout, unstable_settings: appSettings },
  "(app)/index": () => <Text>home stub</Text>,
  "(app)/opportunities/[id]": OpportunityRoute,
};

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  mockSession.current = RESTORING;
  jest.mocked(apiGet).mockReset().mockResolvedValue(detail());
});

describe("jackfixit://opportunities/{id}", () => {
  it("on a cold start waits for the session restore, then lands on the detail; Back goes home", async () => {
    const result = await renderRouter(routes, { initialUrl: LINK });

    expect(screen.getByTestId("restoring-hero")).toBeTruthy();
    expect(apiGet).not.toHaveBeenCalled();

    await act(async () => setSession({ status: "signedIn", user: PRO }));

    await waitFor(() => expect(result.getPathname()).toBe(LINK));
    expect(await screen.findByText("JF-000124")).toBeTruthy();
    expect(apiGet).toHaveBeenCalledWith(
      "/v1/pros/me/opportunities/{dispatch_id}",
      expect.objectContaining({ params: { dispatch_id: DISPATCH_ID } }),
    );

    await fireEvent.press(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(result.getPathname()).toBe("/"));
    expect(screen.getByText("home stub")).toBeTruthy();
  });

  it("on a warm start opens the detail over the home; Back returns to it", async () => {
    setSession({ status: "signedIn", user: PRO });
    const result = await renderRouter(routes, { initialUrl: "/" });
    expect(screen.getByText("home stub")).toBeTruthy();

    await act(async () => router.push(LINK));

    expect(result.getPathname()).toBe(LINK);
    expect(await screen.findByText("JF-000124")).toBeTruthy();

    await fireEvent.press(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(result.getPathname()).toBe("/"));
    expect(screen.getByText("home stub")).toBeTruthy();
  });

  it("signed out, the link lands on welcome and asks the API for nothing", async () => {
    setSession({ status: "signedOut" });
    const result = await renderRouter(routes, { initialUrl: LINK });

    expect(result.getPathname()).toBe("/welcome");
    expect(screen.getByText("welcome stub")).toBeTruthy();
    expect(apiGet).not.toHaveBeenCalled();
  });
});
