// The selfie step's camera under the real router (#294 Vault V1): a route pushed over sign-up
// unmounts the live preview, and coming back mounts a new one that has to report ready itself.
// The real SignUpScreen, SessionGate and (auth) layout; the camera is the manual mock in
// apps/mobile/__mocks__, holding each preview's ready for the test to send.
import "@/i18n";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { router, useIsFocused } from "expo-router";
import { act, renderRouter, screen, waitFor } from "expo-router/testing-library";
import { useEffect } from "react";
import { Text } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import type * as CameraMock from "../../../../__mocks__/expo-camera";
import {
  authResponse,
  installFetchMock,
  jsonResponse,
  resetSecureStore,
  user,
} from "../../../api/__tests__/helpers";
import { attachQueryClient, register, sessionStore } from "../../../api/session";
import AuthLayout, { unstable_settings } from "../../../app/(auth)/_layout";
import { SessionGate } from "../SessionGate";
import { SignUpScreen } from "../SignUpScreen";
import { METRICS, SIGNED_OUT } from "./helpers";

jest.mock(
  "../../../api/config",
  () => jest.requireActual("../../../api/__tests__/helpers").configMock,
);
jest.mock(
  "expo-secure-store",
  () => jest.requireActual("../../../api/__tests__/helpers").secureStoreMock,
);
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);
// One instance for the screen and this file: the mock-only helpers drive what the screen sees.
jest.mock("expo-camera");
jest.mock("expo-image-picker", () => ({ launchImageLibraryAsync: jest.fn() }));
jest.mock("expo-haptics", () => ({
  notificationAsync: jest.fn(async () => undefined),
  impactAsync: jest.fn(async () => undefined),
  NotificationFeedbackType: { Success: "success" },
  ImpactFeedbackStyle: { Light: "light" },
}));
// The card's 3D view is not what this file tests.
jest.mock("../../../components/ui/IdCard", () => ({ IdCard: () => null }));

const { cameraMock, CAMERA_PERMISSION, getCameraPermissionsAsync } =
  jest.requireMock<typeof CameraMock>("expo-camera");

/** A pro whose name and home are saved: the flow opens on the selfie step. */
const placed = {
  ...user,
  role: "pro" as const,
  first_name: "Ana",
  last_name: "Lima",
  home_city: "Miami",
  home_state: "FL",
  photo: null,
};

/** Whether the sign-up screen is the one in front, as the router last committed it. */
const signUp = { focused: false };
/** Each sign-up screen the router mounted: the one that comes back must be the same. */
const mounts = { count: 0 };
function ObservedSignUp() {
  const focused = useIsFocused();
  useEffect(() => {
    signUp.focused = focused;
  }, [focused]);
  useEffect(() => {
    mounts.count += 1;
  }, []);
  return <SignUpScreen />;
}

const cameras = () =>
  screen.queryAllByTestId("sign-up-photo-camera", { includeHiddenElements: true });
const takePhoto = () => screen.getByRole("button", { name: "Take photo" });

let client: QueryClient;

beforeEach(async () => {
  signUp.focused = false;
  mounts.count = 0;
  resetSecureStore();
  sessionStore.setState(SIGNED_OUT);
  cameraMock.mountError = null;
  cameraMock.holdReady = true;
  cameraMock.pendingReady = [];
  cameraMock.pendingError = [];
  getCameraPermissionsAsync.mockReset().mockResolvedValue(CAMERA_PERMISSION.granted);
  installFetchMock().mockResolvedValue(jsonResponse(200, { ...authResponse(1), user: placed }));
  client = new QueryClient({
    defaultOptions: { queries: { gcTime: Infinity }, mutations: { gcTime: Infinity } },
  });
  attachQueryClient(client);
  await register(
    { email: placed.email, password: "a long enough password", role: "pro", locale: "en" },
    { onboarding: true },
  );
});

afterEach(() => {
  client.clear();
  cameraMock.holdReady = false;
});

describe("SignUpScreen: the selfie camera under the router", () => {
  it("a route pushed over sign-up releases the camera; back in front, Take photo waits for a new preview", async () => {
    const view = await renderRouter(
      {
        _layout: () => (
          <QueryClientProvider client={client}>
            <SafeAreaProvider initialMetrics={METRICS}>
              <SessionGate />
            </SafeAreaProvider>
          </QueryClientProvider>
        ),
        "(auth)/_layout": { default: AuthLayout, unstable_settings },
        "(auth)/welcome": () => <Text>Welcome</Text>,
        "(auth)/login": () => <Text>Another screen</Text>,
        "(auth)/sign-up": ObservedSignUp,
        "(app)/_layout": () => <Text>App</Text>,
      },
      { initialUrl: "/sign-up" },
    );
    try {
      await screen.findByTestId("sign-up-photo-camera");
      await waitFor(() => expect(cameraMock.pendingReady).toHaveLength(1));
      const covered = cameraMock.pendingReady[0];
      const coveredError = cameraMock.pendingError[0];
      await act(async () => covered?.());
      expect(signUp.focused).toBe(true);
      expect(takePhoto()).toBeEnabled();
      expect(mounts.count).toBe(1);

      await act(async () => router.push("/(auth)/login"));
      await screen.findByText("Another screen");
      expect(view.getPathname()).toBe("/login");
      expect(signUp.focused).toBe(false);
      // Sign-up stays in the stack behind the other screen, on its step, without a camera.
      expect(screen.getByTestId("sign-up-photo", { includeHiddenElements: true })).toBeTruthy();
      expect(cameras()).toHaveLength(0);
      // The released preview reports late: neither report counts.
      await act(async () => covered?.());
      await act(async () => coveredError?.("late"));

      await act(async () => router.back());
      await waitFor(() => expect(signUp.focused).toBe(true));
      expect(view.getPathname()).toBe("/sign-up");
      // The same screen came back (not a new mount): the old preview's id was retired in it.
      expect(mounts.count).toBe(1);
      await waitFor(() => expect(cameraMock.pendingReady).toHaveLength(2));
      expect(cameras()).toHaveLength(1);
      expect(takePhoto()).toBeDisabled();
      await act(async () => covered?.());
      await act(async () => coveredError?.("late"));
      expect(takePhoto()).toBeDisabled();

      // Only the new preview's own ready enables the shutter.
      await act(async () => cameraMock.pendingReady[1]?.());
      expect(takePhoto()).toBeEnabled();
    } finally {
      await view.unmount();
    }
  });
});
