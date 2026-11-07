import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react-native";
import { createElement, useState, type ReactElement, type ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { createPanelHandoff, PanelHandoffProvider, type PanelHandoff } from "../panelHandoff";

/** A 320 dp phone with a status bar and a gesture bar, like the evidence emulator. */
export const METRICS = {
  frame: { x: 0, y: 0, width: 320, height: 640 },
  insets: { top: 24, right: 0, bottom: 16, left: 0 },
};

/**
 * A Query cache for a router test that mounts the real signed-in shell (the tabs ask for an
 * ongoing job, #64), as the app's root layout provides one. One cache per mount; nothing expires.
 */
export function WithQuery({ children }: { children: ReactNode }) {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } }),
  );
  return createElement(QueryClientProvider, { client }, children);
}

/** The tree `renderInSafeArea` renders: also what a test passes to `rerender`. */
export const inSafeArea = (ui: ReactElement, handoff: PanelHandoff) =>
  createElement(
    SafeAreaProvider,
    { initialMetrics: METRICS },
    createElement(PanelHandoffProvider, { value: handoff }, ui),
  );

/**
 * Renders a screen under a SafeAreaProvider (the test file mocks the safe-area module itself) and
 * the auth flow's panel hand-off: a fresh one, or the test's own to drive and read.
 */
export const renderInSafeArea = (ui: ReactElement, handoff: PanelHandoff = createPanelHandoff()) =>
  render(inSafeArea(ui, handoff));

/** Every field of the store when nobody is signed in. */
export const SIGNED_OUT = {
  status: "signedOut" as const,
  user: null,
  accessToken: null,
  accessTokenExpiresAt: null,
  cleanupPending: false,
  restoreFailure: null,
  onboardingUserId: null,
};
