// The smoke screen against the manual mocks in apps/mobile/__mocks__: every library call is
// asserted, and the mocks' answers drive each state the screen can show.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { ImpactFeedbackStyle, impactAsync } from "expo-haptics";
import { isAvailableAsync, shareAsync } from "expo-sharing";
import {
  AppState,
  Image,
  Linking,
  type AppStateStatus,
  type NativeEventSubscription,
} from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import { captureRef } from "react-native-view-shot";

import type * as CameraMock from "../../../../__mocks__/expo-camera";
import type * as SensorsMock from "../../../../__mocks__/expo-sensors";
import type * as ViewShotMock from "../../../../__mocks__/react-native-view-shot";
import { IdCardLibsSample } from "../IdCardLibsSample";
import "@/i18n";

// Root __mocks__ apply on their own, but a module reached through a plain import lives in Jest's
// module registry while `jest.requireMock` fills the mock registry: an explicit jest.mock makes
// both read the one instance, so the mock-only helpers below drive what the screen sees.
jest.mock("expo-camera");
jest.mock("expo-sensors");
jest.mock("react-native-view-shot");
jest.mock("expo-router", () => ({ useIsFocused: jest.fn(() => true) }));
jest.mock("react-native-reanimated", () => {
  const actual =
    jest.requireActual<typeof import("react-native-reanimated")>("react-native-reanimated");
  return { __esModule: true, ...actual, useReducedMotion: jest.fn(() => false) };
});

const { CAMERA_PERMISSION, cameraMock, getCameraPermissionsAsync, requestCameraPermissionsAsync } =
  jest.requireMock<typeof CameraMock>("expo-camera");
const { Gyroscope } = jest.requireMock<typeof SensorsMock>("expo-sensors");
const { MOCK_CAPTURE_URI } = jest.requireMock<typeof ViewShotMock>("react-native-view-shot");

const PNG_SIZE = { width: 1038, height: 654 };

beforeEach(() => {
  jest.mocked(useReducedMotion).mockReturnValue(false);
  getCameraPermissionsAsync.mockClear().mockResolvedValue(CAMERA_PERMISSION.undetermined);
  requestCameraPermissionsAsync.mockClear().mockResolvedValue(CAMERA_PERMISSION.granted);
  cameraMock.mountError = null;
  jest.mocked(captureRef).mockClear();
  jest.mocked(isAvailableAsync).mockClear().mockResolvedValue(true);
  jest.mocked(shareAsync).mockClear();
  jest.mocked(AppState.addEventListener).mockClear();
  jest.mocked(impactAsync).mockClear();
  Gyroscope.reset();
  jest.spyOn(Image, "getSize").mockImplementation(() => Promise.resolve(PNG_SIZE));
});

afterEach(() => {
  jest.restoreAllMocks();
});

/** The one foreground listener the mounted screen registered, with its subscription. */
function appStateSubscription() {
  const { calls, results } = jest.mocked(AppState.addEventListener).mock;
  expect(calls).toEqual([["change", expect.any(Function)]]);
  return {
    onChange: calls[0]?.[1] as (state: AppStateStatus) => void,
    subscription: results[0]?.value as NativeEventSubscription,
  };
}

describe("camera", () => {
  it("asks once, then shows the front preview and reports it ready", async () => {
    await render(<IdCardLibsSample />);
    expect(await screen.findByText("Not asked")).toBeTruthy();

    await act(async () => fireEvent.press(screen.getByRole("button", { name: "Allow camera" })));

    expect(requestCameraPermissionsAsync).toHaveBeenCalledTimes(1);
    const preview = await screen.findByTestId("camera-preview");
    expect(preview.props.facing).toBe("front");
    expect(preview.props.active).toBe(true);
    expect(await screen.findByText("Ready")).toBeTruthy();

    // The prompt itself sends the app to the background and back: the return re-reads (the system
    // now answers granted), never asks again, and the preview stays.
    getCameraPermissionsAsync.mockResolvedValue(CAMERA_PERMISSION.granted);
    const { onChange } = appStateSubscription();
    await act(async () => onChange("active"));
    expect(getCameraPermissionsAsync).toHaveBeenCalledTimes(2);
    expect(requestCameraPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("camera-preview")).toBeTruthy();
  });

  it("a lens that cannot start says why and offers the other one", async () => {
    getCameraPermissionsAsync.mockResolvedValue(CAMERA_PERMISSION.granted);
    cameraMock.mountError = "No front camera";
    await render(<IdCardLibsSample />);

    expect(await screen.findByText("Camera could not start")).toBeTruthy();
    expect(screen.getByText("No front camera")).toBeTruthy();
    expect(screen.getByText("Failed")).toBeTruthy();

    cameraMock.mountError = null;
    await act(async () =>
      fireEvent.press(screen.getByRole("button", { name: "Use the back camera" })),
    );

    expect(screen.getByTestId("camera-preview").props.facing).toBe("back");
    expect(await screen.findByText("Ready")).toBeTruthy();
    expect(screen.queryByText("Camera could not start")).toBeNull();
  });

  it("a blocked camera leads to Settings, and a grant there shows the preview on return", async () => {
    getCameraPermissionsAsync.mockResolvedValue(CAMERA_PERMISSION.blocked);
    const openSettings = jest.spyOn(Linking, "openSettings").mockResolvedValue(undefined);
    await render(<IdCardLibsSample />);

    const settings = await screen.findByRole("button", { name: "Open settings" });
    await act(async () => fireEvent.press(settings));

    expect(openSettings).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Allow camera" })).toBeNull();
    expect(getCameraPermissionsAsync).toHaveBeenCalledTimes(1);

    // Granted in Settings, then back to this same mounted screen: leaving reads nothing, returning
    // reads the permission again without a prompt, and the preview takes the notice's place.
    getCameraPermissionsAsync.mockResolvedValue(CAMERA_PERMISSION.granted);
    const { onChange, subscription } = appStateSubscription();
    await act(async () => onChange("background"));
    expect(getCameraPermissionsAsync).toHaveBeenCalledTimes(1);
    await act(async () => onChange("active"));

    expect(await screen.findByTestId("camera-preview")).toBeTruthy();
    expect(screen.queryByText("Camera access is off")).toBeNull();
    expect(await screen.findByText("Ready")).toBeTruthy();
    expect(getCameraPermissionsAsync).toHaveBeenCalledTimes(2);
    expect(requestCameraPermissionsAsync).not.toHaveBeenCalled();

    await screen.unmount();
    expect(subscription.remove).toHaveBeenCalledTimes(1);
  });
});

describe("card snapshot and share sheet", () => {
  it("captures the card as a PNG, reports the pixel size, then shares that file", async () => {
    await render(<IdCardLibsSample />);
    expect(await screen.findByRole("button", { name: "Share PNG" })).toBeDisabled();

    await act(async () => fireEvent.press(screen.getByRole("button", { name: "Capture PNG" })));

    expect(await screen.findByText("1038 x 654 px")).toBeTruthy();
    expect(captureRef).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ format: "png" }),
    );
    expect(screen.getByTestId("captured-card").props.source).toEqual({ uri: MOCK_CAPTURE_URI });
    expect(screen.getByRole("button", { name: "Share PNG" })).toBeEnabled();

    await act(async () => fireEvent.press(screen.getByRole("button", { name: "Share PNG" })));

    await waitFor(() =>
      expect(shareAsync).toHaveBeenCalledWith(
        MOCK_CAPTURE_URI,
        expect.objectContaining({ mimeType: "image/png" }),
      ),
    );
    expect(await screen.findByText("Shared x1")).toBeTruthy();
  });

  it("a capture that fails says so and keeps the retry", async () => {
    jest.mocked(captureRef).mockRejectedValueOnce(new Error("Snapshot failed"));
    await render(<IdCardLibsSample />);

    const capture = await screen.findByRole("button", { name: "Capture PNG" });
    await act(async () => fireEvent.press(capture));

    expect(await screen.findByText("Capture failed")).toBeTruthy();
    expect(screen.getByText("Snapshot failed")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Capture PNG" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Share PNG" })).toBeDisabled();
  });

  it("a share sheet probe that fails says why and keeps sharing off", async () => {
    jest.mocked(isAvailableAsync).mockRejectedValueOnce(new Error("Sharing is not linked"));
    await render(<IdCardLibsSample />);

    expect(await screen.findByText("Could not check the share sheet")).toBeTruthy();
    expect(screen.getByText("Sharing is not linked")).toBeTruthy();
    expect(screen.getByText("Failed")).toBeTruthy();

    await act(async () => fireEvent.press(screen.getByRole("button", { name: "Capture PNG" })));

    expect(await screen.findByText("1038 x 654 px")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Share PNG" })).toBeDisabled();
  });
});

describe("gyroscope", () => {
  it("subscribes every 100 ms, shows each reading and unsubscribes on unmount", async () => {
    await render(<IdCardLibsSample />);
    expect(await screen.findByText("Listening")).toBeTruthy();
    expect(Gyroscope.updateIntervalMs).toBe(100);
    expect(Gyroscope.getListenerCount()).toBe(1);

    await act(async () => {
      Gyroscope.emit({ x: 0.5, y: -0.25, z: 0, timestamp: 1 });
    });

    expect(screen.getByTestId("gyro-reading").props.children).toBe("x 0.50   y -0.25   z 0.00");

    await screen.unmount();
    expect(Gyroscope.getListenerCount()).toBe(0);
  });

  it("under Reduce Motion nothing subscribes: drag only", async () => {
    jest.mocked(useReducedMotion).mockReturnValue(true);
    await render(<IdCardLibsSample />);

    expect(await screen.findByText("Drag only")).toBeTruthy();
    expect(screen.getByText(/Reduce Motion is on/)).toBeTruthy();
    expect(Gyroscope.addListener).not.toHaveBeenCalled();
  });

  it("without a gyroscope says so and never subscribes", async () => {
    Gyroscope.available = false;
    await render(<IdCardLibsSample />);

    expect(await screen.findByText("No gyroscope")).toBeTruthy();
    expect(Gyroscope.addListener).not.toHaveBeenCalled();
  });

  it("a gyroscope probe that fails says why and never subscribes", async () => {
    Gyroscope.isAvailableAsync.mockRejectedValueOnce(new Error("Sensor service down"));
    await render(<IdCardLibsSample />);

    expect(await screen.findByText("Could not check the gyroscope")).toBeTruthy();
    expect(screen.getByText("Sensor service down")).toBeTruthy();
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.queryByText(/reports no gyroscope/)).toBeNull();
    expect(Gyroscope.addListener).not.toHaveBeenCalled();
  });
});

describe("haptics", () => {
  it("sends a light impact and counts it", async () => {
    await render(<IdCardLibsSample />);

    await act(async () => fireEvent.press(screen.getByRole("button", { name: "Light tap" })));

    expect(impactAsync).toHaveBeenCalledWith(ImpactFeedbackStyle.Light);
    expect(await screen.findByText("Sent x1")).toBeTruthy();
  });
});
