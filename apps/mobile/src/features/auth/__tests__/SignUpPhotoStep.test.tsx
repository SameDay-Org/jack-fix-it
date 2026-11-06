// The selfie step (#294) of the sign-up flow, against the manual expo-camera mock in
// apps/mobile/__mocks__: permission states, capture and retake, the library fallback, and the
// upload + PATCH with their failures and retries. The flow opens here by resuming an account
// whose name and home are saved.
import "@/i18n";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import { impactAsync } from "expo-haptics";
import { launchImageLibraryAsync } from "expo-image-picker";
import { useLocalSearchParams } from "expo-router";
import { AccessibilityInfo, AppState, Linking, type AppStateStatus } from "react-native";

import {
  ApiError,
  apiPatch,
  endOnboarding,
  NetworkError,
  sessionGeneration,
  UploadFailedError,
  UploadRejectedError,
  uploadMedia,
  type SessionUser,
} from "@/api";
import { prepareMedia } from "@/features/media/compress";

import type * as CameraMock from "../../../../__mocks__/expo-camera";
import {
  authResponse,
  callsTo,
  deferred,
  installFetchMock,
  jsonResponse,
  user,
} from "../../../api/__tests__/helpers";
import { apiPatch as sentPatch } from "../../../api/client";
import { login, sessionStore } from "../../../api/session";
import { phoneFlowStore } from "../../phone/phoneFlow";
import { SignUpScreen } from "../SignUpScreen";
import { renderInSafeArea, SIGNED_OUT } from "./helpers";

jest.mock(
  "../../../api/config",
  () => jest.requireActual("../../../api/__tests__/helpers").configMock,
);
jest.mock(
  "expo-secure-store",
  () => jest.requireActual("../../../api/__tests__/helpers").secureStoreMock,
);
jest.mock("@/api", () => ({
  ...jest.requireActual("@/api"),
  apiPatch: jest.fn(),
  uploadMedia: jest.fn(),
  endOnboarding: jest.fn(async () => {
    if (mockGuard.on) throw new Error("ended while the screen still blocks leaving");
  }),
}));
jest.mock("@/features/media/compress", () => ({ prepareMedia: jest.fn() }));
// One instance for the screen and this file: the mock-only helpers drive what the screen sees.
jest.mock("expo-camera");
jest.mock("expo-image-picker", () => ({ launchImageLibraryAsync: jest.fn() }));
const mockGuard = { on: false, onBlocked: (): void => undefined };
jest.mock("expo-router", () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn(), dismissTo: jest.fn() },
  useLocalSearchParams: jest.fn(() => ({})),
  Redirect: jest.fn(() => null),
  usePreventRemove: jest.fn((on: boolean, onBlocked: () => void) => {
    mockGuard.on = on;
    mockGuard.onBlocked = onBlocked;
  }),
}));
jest.mock("react-native-reanimated", () => {
  const actual =
    jest.requireActual<typeof import("react-native-reanimated")>("react-native-reanimated");
  return {
    __esModule: true,
    ...actual,
    withTiming: (to: number, _config?: object, done?: (finished?: boolean) => void) => {
      done?.(true);
      return to;
    },
  };
});
jest.mock("expo-haptics", () => ({
  notificationAsync: jest.fn(async () => undefined),
  impactAsync: jest.fn(async () => undefined),
  NotificationFeedbackType: { Success: "success" },
  ImpactFeedbackStyle: { Light: "light" },
}));
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);
// The card has its own tests (#291): here it shows the photo the flow hands it.
jest.mock("../../../components/ui/IdCard", () => ({
  IdCard: ({ name, photoUri }: Record<string, string | undefined>) => {
    const { Text } = jest.requireActual<typeof import("react-native")>("react-native");
    return <Text testID="card">{`${name ?? ""}|${photoUri ?? ""}`}</Text>;
  },
}));

const {
  CAMERA_PERMISSION,
  cameraMock,
  getCameraPermissionsAsync,
  requestCameraPermissionsAsync,
  takePictureAsync,
} = jest.requireMock<typeof CameraMock>("expo-camera");

const SHOT = "file:///data/cache/Camera/selfie.jpg";
const PICKED = "file:///data/cache/ImagePicker/picked.jpg";
const SAVED = "https://storage.example/photo.jpg";
const prepared = (uri: string) => ({
  uri: `${uri}.small.jpg`,
  contentType: "image/jpeg",
  kind: "image" as const,
});

const placed: SessionUser = {
  ...user,
  role: "pro",
  first_name: "Ana",
  last_name: "Cruz",
  home_city: "Miami",
  home_state: "FL",
};

const card = () => screen.getByTestId("card").props.children as string;
const button = (name: string) => screen.getByRole("button", { name });
const preview = () => screen.getByTestId("sign-up-photo-camera");

/** The account in the session store, signed in and on its flow, with its name and home saved. */
function onFlow(account: SessionUser = placed) {
  sessionStore.setState({
    status: "signedIn",
    user: account,
    accessToken: "access",
    accessTokenExpiresAt: Date.now() + 60_000,
    onboardingUserId: account.id,
  });
}

/** PATCH /v1/auth/me answers with the account, its photo set. */
function patchesPhoto() {
  jest.mocked(apiPatch).mockImplementation(async () => ({
    ...(sessionStore.getState().user as SessionUser),
    photo: { url: SAVED, expires_at: "2026-11-06T12:00:00Z" },
  }));
}

async function renderStep() {
  const client = new QueryClient({
    defaultOptions: { queries: { gcTime: Infinity }, mutations: { gcTime: Infinity } },
  });
  await renderInSafeArea(
    <QueryClientProvider client={client}>
      <SignUpScreen />
    </QueryClientProvider>,
  );
  expect(await screen.findByText("Let's see that face!")).toBeTruthy();
}

/** The step titled `title` is on screen and its slide is over. */
async function arrive(title: string) {
  const heading = await screen.findByText(title);
  await waitFor(() =>
    expect(
      screen.getByTestId("sign-up-step-leaving", { includeHiddenElements: true }).props.children,
    ).toBeNull(),
  );
  return heading;
}

async function press(name: string) {
  await act(async () => fireEvent.press(button(name)));
}

/** The one foreground listener the camera access registered. */
function onAppState(): (state: AppStateStatus) => void {
  const { calls } = jest.mocked(AppState.addEventListener).mock;
  return calls[calls.length - 1]?.[1] as (state: AppStateStatus) => void;
}

/** The camera is on and ready; the photo is taken. */
async function takePhoto() {
  await waitFor(() => expect(button("Take photo")).toBeEnabled());
  await press("Take photo");
  await screen.findByTestId("sign-up-photo-photo");
}

let announce: jest.SpyInstance;
let announceQueued: jest.SpyInstance;

beforeEach(() => {
  mockGuard.on = false;
  sessionStore.setState(SIGNED_OUT);
  phoneFlowStore.setState({ pendingNumber: null, offeredAfterSignUp: false });
  jest.mocked(useLocalSearchParams).mockReturnValue({});
  jest.mocked(apiPatch).mockReset();
  jest.mocked(uploadMedia).mockReset().mockResolvedValue({ key: "profile_photo/ana.jpg" });
  jest
    .mocked(prepareMedia)
    .mockReset()
    .mockImplementation(async ({ uri }) => prepared(uri));
  jest.mocked(endOnboarding).mockClear();
  jest.mocked(launchImageLibraryAsync).mockReset();
  jest.mocked(impactAsync).mockClear();
  jest.mocked(AppState.addEventListener).mockClear();
  getCameraPermissionsAsync.mockReset().mockResolvedValue(CAMERA_PERMISSION.granted);
  requestCameraPermissionsAsync.mockReset().mockResolvedValue(CAMERA_PERMISSION.granted);
  takePictureAsync.mockClear();
  cameraMock.mountError = null;
  cameraMock.holdReady = false;
  cameraMock.pendingReady = [];
  cameraMock.pendingError = [];
  announce = jest
    .spyOn(AccessibilityInfo, "announceForAccessibility")
    .mockImplementation(() => undefined);
  announceQueued = jest
    .spyOn(AccessibilityInfo, "announceForAccessibilityWithOptions")
    .mockImplementation(() => undefined);
});

afterEach(() => {
  announce.mockRestore();
  announceQueued.mockRestore();
  jest.restoreAllMocks();
});

describe("SignUpScreen: the selfie step, the camera", () => {
  it("resumes here once the home is saved, and asks for the camera before opening it", async () => {
    getCameraPermissionsAsync.mockResolvedValue(CAMERA_PERMISSION.undetermined);
    onFlow();
    await renderStep();
    expect(screen.getByLabelText("Step 4 of 4")).toBeTruthy();
    expect(card()).toBe("Ana Cruz|");
    expect(screen.queryByTestId("sign-up-photo-camera")).toBeNull();
    // The library is there too, for a person who would rather not turn the camera on.
    expect(button("Choose a photo")).toBeTruthy();

    await press("Turn on camera");

    expect(requestCameraPermissionsAsync).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(button("Take photo")).toBeEnabled());
    expect(preview().props.facing).toBe("front");
    expect(preview().props.active).toBe(true);
    expect(screen.queryByRole("button", { name: "Choose a photo" })).toBeNull();
    // No skip: the card needs a face. Back is still there.
    expect(screen.queryByRole("button", { name: /skip/i })).toBeNull();
    expect(button("Back")).toBeTruthy();
  });

  it("takes the photo into the frame and the card; Retake opens the camera again", async () => {
    onFlow();
    await renderStep();

    await takePhoto();

    expect(takePictureAsync).toHaveBeenCalledWith({ exif: false });
    expect(impactAsync).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("sign-up-photo-photo").props.source).toEqual({ uri: SHOT });
    expect(card()).toBe(`Ana Cruz|${SHOT}`);
    expect(screen.queryByTestId("sign-up-photo-camera")).toBeNull();
    expect(button("Use photo")).toBeTruthy();
    expect(uploadMedia).not.toHaveBeenCalled(); // nothing goes before "Use photo"

    await press("Retake");

    expect(card()).toBe("Ana Cruz|");
    await waitFor(() => expect(button("Take photo")).toBeEnabled());
    expect(preview()).toBeTruthy();
  });

  it("a camera that would not start offers the photo library instead", async () => {
    cameraMock.mountError = "Camera could not be started";
    onFlow();
    await renderStep();

    // A camera that would not start: the library is the way on.
    expect(await screen.findByText("The camera couldn't start")).toBeTruthy();
    expect(takePictureAsync).not.toHaveBeenCalled();
    jest.mocked(launchImageLibraryAsync).mockResolvedValue({
      canceled: false,
      assets: [{ uri: PICKED, width: 1200, height: 1600 }],
    });

    await press("Choose a photo");

    expect(launchImageLibraryAsync).toHaveBeenCalledWith({ mediaTypes: ["images"], exif: false });
    expect(await screen.findByTestId("sign-up-photo-photo")).toBeTruthy();
    expect(card()).toBe(`Ana Cruz|${PICKED}`);
  });

  it("a ready the failed preview had queued changes nothing; the next preview waits for its own", async () => {
    cameraMock.holdReady = true;
    onFlow();
    await renderStep();
    await waitFor(() => expect(cameraMock.pendingReady).toHaveLength(1));
    const failedReady = cameraMock.pendingReady[0];

    // The preview fails to start: it is unmounted and the library takes over.
    await act(async () => cameraMock.pendingError[0]?.("Camera could not be started"));
    expect(await screen.findByText("The camera couldn't start")).toBeTruthy();
    expect(screen.queryByTestId("sign-up-photo-camera")).toBeNull();

    // Its ready arrives afterwards: no camera comes back, and nothing can take a photo.
    await act(async () => failedReady?.());
    expect(screen.getByText("The camera couldn't start")).toBeTruthy();
    expect(screen.queryByTestId("sign-up-photo-camera")).toBeNull();
    expect(screen.queryByRole("button", { name: "Take photo" })).toBeNull();
    expect(cameraMock.pendingReady).toHaveLength(1);

    // Leaving and coming back tries the camera again, with a preview that reports for itself.
    await press("Back");
    expect(await arrive("Where do you live?")).toBeTruthy();
    jest.mocked(apiPatch).mockImplementation(async () => sessionStore.getState().user as never);
    await press("Continue");
    expect(await arrive("Let's see that face!")).toBeTruthy();
    await waitFor(() => expect(cameraMock.pendingReady).toHaveLength(2));
    expect(button("Take photo")).toBeDisabled();
    await act(async () => failedReady?.());
    expect(button("Take photo")).toBeDisabled();
    await act(async () => cameraMock.pendingReady[1]?.());
    expect(button("Take photo")).toBeEnabled();
    expect(takePictureAsync).not.toHaveBeenCalled();
  });

  it("a shutter that fails says so and keeps the camera", async () => {
    onFlow();
    await renderStep();
    takePictureAsync.mockRejectedValueOnce(new Error("capture failed"));
    await waitFor(() => expect(button("Take photo")).toBeEnabled());

    await press("Take photo");

    expect(await screen.findByText("We couldn't get the photo. Try again.")).toBeTruthy();
    expect(preview()).toBeTruthy();
  });
});

describe("SignUpScreen: the selfie step, a refused camera", () => {
  it("off for good: Open settings, the library, and the camera once access is back", async () => {
    getCameraPermissionsAsync.mockResolvedValue(CAMERA_PERMISSION.blocked);
    const openSettings = jest.spyOn(Linking, "openSettings").mockResolvedValue(undefined);
    onFlow();
    await renderStep();

    expect(await screen.findByText("Camera access is off")).toBeTruthy();
    expect(button("Choose a photo")).toBeTruthy();
    await press("Open settings");
    expect(openSettings).toHaveBeenCalledTimes(1);
    expect(requestCameraPermissionsAsync).not.toHaveBeenCalled();

    // Back from Settings with the camera turned on: the preview starts on its own.
    getCameraPermissionsAsync.mockResolvedValue(CAMERA_PERMISSION.granted);
    await act(async () => onAppState()("active"));

    await waitFor(() => expect(button("Take photo")).toBeEnabled());
    expect(screen.queryByText("Camera access is off")).toBeNull();
  });

  it("access turned off and on again on the step: Take photo waits for the new preview", async () => {
    getCameraPermissionsAsync.mockResolvedValue(CAMERA_PERMISSION.granted);
    onFlow();
    await renderStep();
    await waitFor(() => expect(button("Take photo")).toBeEnabled());

    getCameraPermissionsAsync.mockResolvedValue(CAMERA_PERMISSION.blocked);
    await act(async () => onAppState()("active"));
    expect(await screen.findByText("Camera access is off")).toBeTruthy();

    cameraMock.holdReady = true;
    getCameraPermissionsAsync.mockResolvedValue(CAMERA_PERMISSION.granted);
    await act(async () => onAppState()("active"));
    await waitFor(() => expect(cameraMock.pendingReady).toHaveLength(1));
    expect(button("Take photo")).toBeDisabled();
    await act(async () => cameraMock.pendingReady[0]?.());
    expect(button("Take photo")).toBeEnabled();
  });

  it("refused in the system dialog: the library takes over, and a cancelled pick changes nothing", async () => {
    getCameraPermissionsAsync.mockResolvedValue(CAMERA_PERMISSION.undetermined);
    requestCameraPermissionsAsync.mockResolvedValue(CAMERA_PERMISSION.blocked);
    onFlow();
    await renderStep();

    await press("Turn on camera");
    expect(await screen.findByText("Camera access is off")).toBeTruthy();

    jest.mocked(launchImageLibraryAsync).mockResolvedValueOnce({ canceled: true, assets: null });
    await press("Choose a photo");
    expect(screen.queryByTestId("sign-up-photo-photo")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();

    jest.mocked(launchImageLibraryAsync).mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: PICKED, width: 1200, height: 1600 }],
    });
    await press("Choose a photo");
    expect(await screen.findByTestId("sign-up-photo-photo")).toBeTruthy();

    patchesPhoto();
    await press("Use photo");

    await waitFor(() => expect(endOnboarding).toHaveBeenCalledTimes(1));
    expect(prepareMedia).toHaveBeenCalledWith({ uri: PICKED, kind: "image" });
  });
});

describe("SignUpScreen: the selfie step, saving the photo", () => {
  it("compresses and uploads it, with progress, then sets it on the account; the flow ends", async () => {
    onFlow();
    await renderStep();
    await takePhoto();
    const upload = deferred<{ key: string }>();
    jest.mocked(uploadMedia).mockImplementation(async ({ onProgress }) => {
      onProgress?.(0.4);
      return upload.promise;
    });
    patchesPhoto();

    await press("Use photo");

    expect(prepareMedia).toHaveBeenCalledWith({ uri: SHOT, kind: "image" });
    expect(uploadMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: "profile_photo",
        file: prepared(SHOT),
        generation: sessionGeneration(),
      }),
    );
    const ring = await screen.findByLabelText("Uploading your photo");
    expect(ring.props.accessibilityValue).toEqual(expect.objectContaining({ now: 40 }));
    // Nothing leaves while the photo is saved, and Retake waits too.
    expect(mockGuard.on).toBe(true);
    await act(async () => mockGuard.onBlocked());
    expect(screen.getByText("Let's see that face!")).toBeTruthy();
    expect(button("Retake")).toBeDisabled();
    expect(apiPatch).not.toHaveBeenCalled();

    await act(async () => upload.resolve({ key: "profile_photo/ana.jpg" }));

    await waitFor(() => expect(endOnboarding).toHaveBeenCalledTimes(1));
    expect(apiPatch).toHaveBeenCalledWith(
      "/v1/auth/me",
      { photo_key: "profile_photo/ana.jpg" },
      { auth: true, generation: sessionGeneration() },
    );
    expect(sessionStore.getState().user?.photo?.url).toBe(SAVED);
    expect(phoneFlowStore.getState().offeredAfterSignUp).toBe(true);
  });

  it("another sign-in during the upload: no PATCH as the next account, no failure, the flow goes on (#292 Vault B1)", async () => {
    onFlow();
    await renderStep();
    await takePhoto();
    const upload = deferred<{ key: string }>();
    jest.mocked(uploadMedia).mockImplementation(() => upload.promise);
    // The real client, so the pinned PATCH is refused where it would be sent.
    jest.mocked(apiPatch).mockImplementation(sentPatch);
    const fetch = installFetchMock();
    const second = { ...user, id: "22222222-2222-4222-8222-222222222222" };
    fetch.mockImplementation(async () => jsonResponse(200, { ...authResponse(2), user: second }));

    await press("Use photo");
    expect(uploadMedia).toHaveBeenCalledTimes(1);
    await act(() => login({ email: "b@example.invalid", password: "synthetic test password" }));
    await act(async () => upload.resolve({ key: "profile_photo/ana.jpg" }));

    expect(callsTo(fetch, "/v1/auth/me")).toHaveLength(0);
    expect(endOnboarding).not.toHaveBeenCalled();
    expect(screen.queryByText("We couldn't save your photo. Try again.")).toBeNull();
    expect(sessionStore.getState().user?.id).toBe(second.id);
  });

  it("a failed upload keeps the photo; Try again uploads the same compressed file", async () => {
    onFlow();
    await renderStep();
    await takePhoto();
    jest.mocked(uploadMedia).mockRejectedValueOnce(new UploadFailedError("network"));
    patchesPhoto();

    await press("Use photo");

    expect(await screen.findByText("We couldn't save your photo. Try again.")).toBeTruthy();
    expect(apiPatch).not.toHaveBeenCalled();
    expect(endOnboarding).not.toHaveBeenCalled();
    expect(card()).toBe(`Ana Cruz|${SHOT}`);
    expect(screen.queryByLabelText("Uploading your photo")).toBeNull();

    await press("Try again");

    await waitFor(() => expect(endOnboarding).toHaveBeenCalledTimes(1));
    expect(prepareMedia).toHaveBeenCalledTimes(1);
    expect(uploadMedia).toHaveBeenCalledTimes(2);
    expect(jest.mocked(uploadMedia).mock.calls[1]?.[0].file).toEqual(prepared(SHOT));
  });

  it("a failed PATCH is retried alone: the upload is not sent again", async () => {
    onFlow();
    await renderStep();
    await takePhoto();
    jest.mocked(apiPatch).mockRejectedValueOnce(new NetworkError(false));

    await press("Use photo");

    expect(
      await screen.findByText("No connection. Check your internet and try again."),
    ).toBeTruthy();
    expect(endOnboarding).not.toHaveBeenCalled();

    patchesPhoto();
    await press("Try again");

    await waitFor(() => expect(endOnboarding).toHaveBeenCalledTimes(1));
    expect(uploadMedia).toHaveBeenCalledTimes(1);
    expect(apiPatch).toHaveBeenCalledTimes(2);
  });

  it("a photo the API refuses is set aside and the camera opens for another", async () => {
    onFlow();
    await renderStep();
    await takePhoto();
    jest.mocked(uploadMedia).mockRejectedValueOnce(new UploadRejectedError(422, "upload_invalid"));

    await press("Use photo");

    expect(await screen.findByText("We couldn't use this photo. Take another one.")).toBeTruthy();
    expect(card()).toBe("Ana Cruz|");
    await waitFor(() => expect(button("Take photo")).toBeEnabled());

    // The new photo goes from the start; a refused key from the PATCH is dropped the same way.
    jest.mocked(apiPatch).mockRejectedValueOnce(new ApiError(422, "invalid_media"));
    await takePhoto();
    await press("Use photo");
    expect(await screen.findByText("We couldn't use this photo. Take another one.")).toBeTruthy();
    expect(prepareMedia).toHaveBeenCalledTimes(2);
    expect(endOnboarding).not.toHaveBeenCalled();
  });

  it("a photo the account already holds is shown, and goes on without a request", async () => {
    onFlow();
    await renderStep();
    await waitFor(() => expect(button("Take photo")).toBeEnabled());

    await act(async () =>
      sessionStore.setState({
        user: { ...placed, photo: { url: SAVED, expires_at: "2026-11-06T12:00:00Z" } },
      }),
    );
    expect(screen.getByTestId("sign-up-photo-photo").props.source).toEqual({ uri: SAVED });
    expect(card()).toBe(`Ana Cruz|${SAVED}`);

    await press("Use photo");

    await waitFor(() => expect(endOnboarding).toHaveBeenCalledTimes(1));
    expect(uploadMedia).not.toHaveBeenCalled();
    expect(apiPatch).not.toHaveBeenCalled();
  });

  it("Back releases the camera at once; it returns to the home step", async () => {
    onFlow();
    await renderStep();
    await waitFor(() => expect(button("Take photo")).toBeEnabled());

    await press("Back");
    // The step slides out without its preview: the camera is released from the press on, on
    // Android too (`active={false}` only pauses it on iOS).
    expect(screen.getByTestId("sign-up-photo", { includeHiddenElements: true })).toBeTruthy();
    expect(
      screen.queryByTestId("sign-up-photo-camera", { includeHiddenElements: true }),
    ).toBeNull();
    expect(await arrive("Where do you live?")).toBeTruthy();
    expect(preview).toThrow();
  });

  it("a late ready from the preview Back released cannot enable the next one", async () => {
    cameraMock.holdReady = true;
    onFlow();
    await renderStep();
    await waitFor(() => expect(cameraMock.pendingReady).toHaveLength(1));
    const released = cameraMock.pendingReady[0];
    expect(button("Take photo")).toBeDisabled();

    await press("Back");
    // The released preview reports while its pane is still sliding out, then again once it is gone.
    await act(async () => released?.());
    expect(await arrive("Where do you live?")).toBeTruthy();
    await act(async () => released?.());
    jest.mocked(apiPatch).mockImplementation(async () => sessionStore.getState().user as never);
    await press("Continue");
    expect(await arrive("Let's see that face!")).toBeTruthy();
    await waitFor(() => expect(cameraMock.pendingReady).toHaveLength(2));
    expect(button("Take photo")).toBeDisabled();
    await act(async () => released?.());
    expect(button("Take photo")).toBeDisabled();

    // Only the new preview's own report enables it.
    await act(async () => cameraMock.pendingReady[1]?.());
    expect(button("Take photo")).toBeEnabled();
  });

  it("the photo taken is still there after Back and Continue", async () => {
    onFlow();
    await renderStep();
    await takePhoto();

    await press("Back");
    expect(await arrive("Where do you live?")).toBeTruthy();

    jest.mocked(apiPatch).mockImplementation(async () => sessionStore.getState().user as never);
    await press("Continue");
    expect(await arrive("Let's see that face!")).toBeTruthy();
    expect(card()).toBe(`Ana Cruz|${SHOT}`);
    expect(button("Use photo")).toBeTruthy();
  });
});
