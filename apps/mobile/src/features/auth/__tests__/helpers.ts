import { render } from "@testing-library/react-native";
import { createElement, type ReactElement } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { createPanelHandoff, PanelHandoffProvider, type PanelHandoff } from "../panelHandoff";

/** A 320 dp phone with a status bar and a gesture bar, like the evidence emulator. */
export const METRICS = {
  frame: { x: 0, y: 0, width: 320, height: 640 },
  insets: { top: 24, right: 0, bottom: 16, left: 0 },
};

/**
 * Renders a screen under a SafeAreaProvider (the test file mocks the safe-area module itself) and
 * the auth flow's panel hand-off: a fresh one, or the test's own to drive and read.
 */
export const renderInSafeArea = (ui: ReactElement, handoff: PanelHandoff = createPanelHandoff()) =>
  render(
    createElement(
      SafeAreaProvider,
      { initialMetrics: METRICS },
      createElement(PanelHandoffProvider, { value: handoff }, ui),
    ),
  );

/** Every field of the store when nobody is signed in. */
export const SIGNED_OUT = {
  status: "signedOut" as const,
  user: null,
  accessToken: null,
  accessTokenExpiresAt: null,
  cleanupPending: false,
  restoreFailure: null,
};
