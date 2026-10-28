import "@/i18n";

import { act, renderRouter, screen } from "expo-router/testing-library";
import { router, useLocalSearchParams } from "expo-router";
import { createElement } from "react";
import { Text } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { user } from "../../../api/__tests__/helpers";
import AppLayout, { unstable_settings as appSettings } from "../../../app/(app)/_layout";
import RequestLayout, {
  unstable_settings as requestSettings,
} from "../../../app/(app)/requests/[id]/_layout";
import AuthLayout, { unstable_settings } from "../../../app/(auth)/_layout";
import { METRICS, SIGNED_OUT } from "../../auth/__tests__/helpers";
import { SessionGate } from "../../auth/SessionGate";
import { QUOTES, REQUEST_ID } from "./helpers";

// A session that changes under the mounted router, as a restore that ends signed in does.
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

const QUOTE_ID = QUOTES[1].id;
const LINK = `/requests/${REQUEST_ID}/quotes/${QUOTE_ID}/pro`;
const COMPARE = `/requests/${REQUEST_ID}`;

function ProfileStub() {
  const { id, quoteId } = useLocalSearchParams<{ id: string; quoteId: string }>();
  return <Text>{`profile stub ${id} ${quoteId}`}</Text>;
}

// The real gate, groups and request stack around stub screens: what the link resolves to.
const routes = {
  _layout: () =>
    createElement(SafeAreaProvider, { initialMetrics: METRICS }, createElement(SessionGate)),
  "(auth)/_layout": { default: AuthLayout, unstable_settings },
  "(auth)/welcome": () => <Text>welcome stub</Text>,
  "(app)/_layout": { default: AppLayout, unstable_settings: appSettings },
  "(app)/index": () => <Text>home stub</Text>,
  "(app)/requests/[id]/_layout": { default: RequestLayout, unstable_settings: requestSettings },
  "(app)/requests/[id]/index": () => <Text>compare stub</Text>,
  "(app)/requests/[id]/quotes/[quoteId]/pro": ProfileStub,
};

const SIGNED_IN: MockSession = { ...SESSION_SIGNED_OUT, status: "signedIn", user };

beforeEach(() => {
  mockSession.state = SESSION_SIGNED_OUT;
});

describe("the pro profile link", () => {
  it("resolves on a cold start once the session is restored, with back to the comparison", async () => {
    mockSession.state = { ...SESSION_SIGNED_OUT, status: "restoring" };
    const result = await renderRouter(routes, { initialUrl: LINK });
    expect(screen.queryByText(/profile stub/)).toBeNull(); // the gate holds the launch frame

    await act(async () => mockSession.set(SIGNED_IN));
    expect(result.getPathname()).toBe(LINK);
    expect(screen.getByText(`profile stub ${REQUEST_ID} ${QUOTE_ID}`)).toBeTruthy();

    // The comparison is under the profile even when the link opened the profile directly.
    await act(async () => router.back());
    expect(result.getPathname()).toBe(COMPARE);
    expect(screen.getByText("compare stub")).toBeTruthy();
  });

  it("resolves on a warm start, signed in, with the comparison under it", async () => {
    mockSession.state = SIGNED_IN;
    const result = await renderRouter(routes, { initialUrl: LINK });

    expect(result.getPathname()).toBe(LINK);
    expect(screen.getByText(`profile stub ${REQUEST_ID} ${QUOTE_ID}`)).toBeTruthy();
    expect(router.canGoBack()).toBe(true);
    await act(async () => router.back());
    expect(result.getPathname()).toBe(COMPARE);
  });

  it("lands on welcome while signed out", async () => {
    const result = await renderRouter(routes, { initialUrl: LINK });

    expect(result.getPathname()).toBe("/welcome");
    expect(screen.queryByText(/profile stub/)).toBeNull();
  });
});
