import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react-native";
import { createElement, type ReactElement } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { sessionStore } from "../../../api/session";
import { METRICS } from "../../auth/__tests__/helpers";
import { user } from "../../../api/__tests__/helpers";

/** A well-formed US number (area code and exchange start with 2-9), as typed and as sent. */
export const DIGITS = "4155550123";
export const E164 = "+14155550123";
export const CODE = "123456";

/**
 * Signs the test user in with a fresh access token, so authenticated requests go straight out
 * with it (no refresh).
 */
export function signIn(): void {
  sessionStore.setState({
    status: "signedIn",
    user,
    accessToken: "access-1",
    accessTokenExpiresAt: Date.now() + 15 * 60 * 1000,
    cleanupPending: false,
    restoreFailure: null,
  });
}

/** Renders a screen the way the app does: a query client (no retries) under the safe area. */
export function renderScreen(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    createElement(
      SafeAreaProvider,
      { initialMetrics: METRICS },
      createElement(QueryClientProvider, { client }, ui),
    ),
  );
}

const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug"] as const;

/** Spies on the console; `assertNoPhoneOrCode()` fails if any call carried the number or the code. */
export function watchConsoleForPii(): { assertNoPhoneOrCode: () => void; restore: () => void } {
  const spies = CONSOLE_METHODS.map((method) => jest.spyOn(console, method).mockImplementation());
  return {
    assertNoPhoneOrCode: () => {
      const logged = spies.flatMap((spy) => spy.mock.calls.map((args) => JSON.stringify(args)));
      expect(logged.filter((line) => line.includes(DIGITS) || line.includes(CODE))).toEqual([]);
    },
    restore: () => spies.forEach((spy) => spy.mockRestore()),
  };
}
