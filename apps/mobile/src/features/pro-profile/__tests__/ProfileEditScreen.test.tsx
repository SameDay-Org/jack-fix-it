import "@/i18n";

import type { QueryClient } from "@tanstack/react-query";
import { act, fireEvent, screen } from "@testing-library/react-native";
import { router } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import { AccessibilityInfo } from "react-native";

import {
  ApiError,
  apiGet,
  apiPatch,
  NetworkError,
  uploadMedia,
  UploadFailedError,
  useSession,
} from "@/api";

import { settle } from "../../../api/__tests__/helpers";
import { prepareMedia, type PickedMedia } from "../../media/compress";
import { chooseMediaSource } from "../../media/mediaSource";
import { proProfileQueryKey, type ProProfile } from "../api";
import { proProfileConfig } from "../config";
import { ProProfileEditScreen } from "../ProfileEditScreen";
import {
  CATEGORIES,
  ELECTRICAL,
  EMPTY_PROFILE,
  FULL_PROFILE,
  navigation,
  newQueryClient,
  PAINTING,
  PLUMBING,
  REGIONS,
  renderWithQuery,
  signedIn,
} from "./helpers";

jest.mock("@/api", () => jest.requireActual("./helpers").apiMock());
jest.mock("expo-router", () => jest.requireActual("./helpers").routerMock);
// Root manual mock (apps/mobile/__mocks__): named here so the test and the screen share one instance.
jest.mock("expo-haptics");
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);
// Reduce Motion on: the loading skeleton's endless pulse would otherwise keep the run busy.
jest.mock("react-native-reanimated", () => ({
  __esModule: true,
  ...jest.requireActual<typeof import("react-native-reanimated")>("react-native-reanimated"),
  useReducedMotion: jest.fn(() => true),
}));
jest.mock("expo-image-picker", () => ({
  requestCameraPermissionsAsync: jest.fn(),
  launchCameraAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(),
}));
jest.mock("expo-image-manipulator", () => ({}));
jest.mock("../../media/compress", () => ({ prepareMedia: jest.fn(), compressImage: jest.fn() }));
// "Camera or library" answers at once: the sheet's route is not part of this screen.
jest.mock("../../media/mediaSource", () => ({
  ...jest.requireActual("../../media/mediaSource"),
  chooseMediaSource: jest.fn(),
  closeMediaSourceSheet: jest.fn(),
}));

const PROFILE = "/v1/pros/me";
const SENT = { auth: true, generation: 1 };
const OFFLINE = "You're offline. Check your connection and try again.";
const PHOTO_KEY = "uploads/profile-photo/new";

/** What the API answers now; a test changes it before a refetch. */
let server: { profile: ProProfile; categories: typeof CATEGORIES; regions: typeof REGIONS };
/** The photo upload in flight, settled by hand. */
let upload: { resolve: () => void; reject: (error: unknown) => void } | null;
let client: QueryClient;

const flush = () => act(async () => settle());
const pressed = (testID: string) => act(async () => fireEvent.press(screen.getByTestId(testID)));
const typed = (testID: string, text: string) =>
  act(async () => fireEvent.changeText(screen.getByTestId(testID), text));
const valueOf = (testID: string) => screen.getByTestId(testID).props.value as string;
const stateOf = (testID: string) =>
  screen.getByTestId(testID).props.accessibilityState as { checked?: boolean; disabled?: boolean };
const isChosen = (testID: string) => stateOf(testID).checked === true;
const save = () => pressed("pro-profile-save");
const patches = () => jest.mocked(apiPatch).mock.calls.map(([, body]) => body);
/** What the screen reader was told, in order. */
const announced = () =>
  jest
    .mocked(AccessibilityInfo.announceForAccessibilityWithOptions)
    .mock.calls.map(([text]) => text);
const photoStatus = () => screen.getByTestId("pro-profile-photo-status").props.children as string;

/** Renders the screen and waits for the form (the profile and the two catalogs answered). */
async function open(profile: ProProfile = FULL_PROFILE) {
  server.profile = profile;
  await renderWithQuery(<ProProfileEditScreen />, client);
  await screen.findByTestId("pro-profile-save");
}

/** Picks a photo from the library; its upload waits for the test to settle it. */
async function choosePhoto() {
  jest.mocked(ImagePicker.launchImageLibraryAsync).mockResolvedValueOnce({
    canceled: false,
    assets: [{ uri: "file:///picked/1.jpg", width: 800, height: 800, type: "image" }],
  });
  await pressed("pro-profile-photo-choose");
  await flush();
}

beforeEach(() => {
  jest.clearAllMocks();
  navigation.reset();
  client = newQueryClient();
  server = { profile: FULL_PROFILE, categories: CATEGORIES, regions: REGIONS };
  upload = null;
  jest.mocked(useSession).mockReturnValue(signedIn({ role: "pro", first_name: "Dan" }));
  jest
    .mocked(apiGet)
    .mockImplementation((async (path: string) =>
      path === PROFILE
        ? server.profile
        : path === "/v1/categories"
          ? server.categories
          : server.regions) as unknown as typeof apiGet);
  jest
    .mocked(apiPatch)
    .mockReset()
    .mockImplementation((async () => server.profile) as unknown as typeof apiPatch);
  jest.mocked(chooseMediaSource).mockResolvedValue("library");
  jest.mocked(prepareMedia).mockImplementation(async (file: PickedMedia) => ({
    uri: `${file.uri}.compressed`,
    contentType: "image/jpeg",
    kind: file.kind,
  }));
  jest.mocked(uploadMedia).mockImplementation(
    () =>
      new Promise((resolve, reject) => {
        upload = { resolve: () => resolve({ key: PHOTO_KEY }), reject };
      }),
  );
  jest
    .spyOn(AccessibilityInfo, "announceForAccessibilityWithOptions")
    .mockImplementation(() => undefined);
  jest.spyOn(AccessibilityInfo, "announceForAccessibility").mockImplementation(() => undefined);
});

afterEach(async () => {
  await flush();
  jest.restoreAllMocks();
});

describe("ProProfileEditScreen", () => {
  it("opens with the profile: the bio, the years, the categories and the ZIP codes it has", async () => {
    await open();

    expect(valueOf("pro-profile-bio")).toBe("Licensed plumber.");
    expect(valueOf("pro-profile-years")).toBe("12");
    expect(isChosen("pro-profile-category-plumbing")).toBe(true);
    expect(isChosen("pro-profile-category-electrical")).toBe(false);
    expect(isChosen("pro-profile-zip-33301")).toBe(true);
    expect(isChosen("pro-profile-zip-33304")).toBe(false);
    expect(screen.getByText("South Florida")).toBeTruthy();
    expect(screen.getByText("2 ZIP codes selected")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Change photo" })).toBeTruthy();
  });

  it("Save with nothing changed asks nothing and goes back", async () => {
    await open();
    await save();

    expect(apiPatch).not.toHaveBeenCalled();
    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it("Save sends only the field that changed, and the cached profile becomes the answer", async () => {
    await open();
    const answer = { ...FULL_PROFILE, bio: "Plumber since 2014." };
    server.profile = answer;
    await typed("pro-profile-bio", "Plumber since 2014.");
    await save();

    expect(apiPatch).toHaveBeenCalledTimes(1);
    expect(apiPatch).toHaveBeenCalledWith(PROFILE, { bio: "Plumber since 2014." }, SENT);
    expect(client.getQueryData(proProfileQueryKey(1))).toEqual(answer);
    expect(router.back).toHaveBeenCalledTimes(1);
    expect(announced()).toContain("Profile saved");
  });

  it("a changed set goes whole: the categories and the ZIP codes replace the ones saved", async () => {
    await open();
    await pressed("pro-profile-category-electrical");
    await pressed("pro-profile-zip-33324");
    await pressed("pro-profile-city-Fort Lauderdale");
    await save();

    expect(patches()).toEqual([
      {
        category_ids: [PLUMBING.id, ELECTRICAL.id],
        service_area_ids: ["zip-33301", "zip-33304", "zip-33305"],
      },
    ]);
  });

  it("a first profile: everything typed and chosen goes in one request", async () => {
    await open(EMPTY_PROFILE);
    expect(screen.getByRole("button", { name: "Add photo" })).toBeTruthy();
    await typed("pro-profile-bio", "  Painter.  ");
    await typed("pro-profile-years", "0");
    await pressed("pro-profile-category-painting");
    await pressed("pro-profile-zip-33324");
    await save();

    expect(patches()).toEqual([
      {
        bio: "Painter.",
        years_of_experience: 0,
        category_ids: [PAINTING.id],
        service_area_ids: ["zip-33324"],
      },
    ]);
  });

  it("with no ZIP code chosen, Save says so and asks nothing", async () => {
    await open(EMPTY_PROFILE);
    await typed("pro-profile-bio", "Painter.");
    await save();

    expect(screen.getByTestId("pro-profile-areas-error").props.children).toBe(
      "Choose at least one ZIP code.",
    );
    expect(apiPatch).not.toHaveBeenCalled();
    expect(router.back).not.toHaveBeenCalled();

    // The error leaves as soon as one is chosen.
    await pressed("pro-profile-zip-33324");
    expect(screen.queryByTestId("pro-profile-areas-error")).toBeNull();
  });

  it("years past the API's range are refused before any request", async () => {
    await open();
    await typed("pro-profile-years", "81");
    await save();

    expect(screen.getByTestId("pro-profile-years").props.accessibilityHint).toBe(
      "Enter a number from 0 to 80.",
    );
    expect(apiPatch).not.toHaveBeenCalled();
  });

  it("a new photo uploads as a profile photo, and Save sends its key", async () => {
    await open();
    await choosePhoto();

    expect(uploadMedia).toHaveBeenCalledWith(expect.objectContaining({ purpose: "profile_photo" }));
    expect(ImagePicker.launchImageLibraryAsync).toHaveBeenCalledWith(
      expect.objectContaining({ mediaTypes: ["images"], selectionLimit: 1 }),
    );
    // Save waits for the upload.
    expect(stateOf("pro-profile-save").disabled).toBe(true);
    await save();
    expect(apiPatch).not.toHaveBeenCalled();

    await act(async () => upload?.resolve());
    expect(photoStatus()).toBe("New photo ready. Save to keep it.");
    await save();

    expect(patches()).toEqual([{ photo_key: PHOTO_KEY }]);
  });

  it("choosing again replaces the new photo: only the last one's key goes with Save", async () => {
    await open();
    await choosePhoto();
    await act(async () => upload?.resolve());

    const second = "uploads/profile-photo/second";
    jest.mocked(uploadMedia).mockImplementation(
      () =>
        new Promise((resolve, reject) => {
          upload = { resolve: () => resolve({ key: second }), reject };
        }),
    );
    await choosePhoto();
    expect(ImagePicker.launchImageLibraryAsync).toHaveBeenCalledTimes(2);
    await act(async () => upload?.resolve());
    await save();

    expect(patches()).toEqual([{ photo_key: second }]);
  });

  it("a photo that does not upload keeps the form: a retry, or Save without it", async () => {
    await open();
    await typed("pro-profile-bio", "Plumber since 2014.");
    await choosePhoto();
    await act(async () => upload?.reject(new UploadFailedError("network")));
    await flush();

    expect(photoStatus()).toBe("Upload failed. Check your connection and try again.");
    expect(valueOf("pro-profile-bio")).toBe("Plumber since 2014.");
    expect(isChosen("pro-profile-zip-33301")).toBe(true);

    // The retry uploads the same photo again, without picking it again.
    upload = null;
    await pressed("pro-profile-photo-retry");
    await flush();
    expect(uploadMedia).toHaveBeenCalledTimes(2);
    expect(ImagePicker.launchImageLibraryAsync).toHaveBeenCalledTimes(1);
    await act(async () => upload?.reject(new UploadFailedError("network")));
    await flush();

    // Save still sends what was typed, and no photo.
    await save();
    expect(patches()).toEqual([{ bio: "Plumber since 2014." }]);
  });

  it("a photo the API refuses is set aside, and the form stays as typed", async () => {
    await open();
    await typed("pro-profile-bio", "Plumber since 2014.");
    await choosePhoto();
    await act(async () => upload?.resolve());
    jest.mocked(apiPatch).mockRejectedValueOnce(new ApiError(422, "invalid_media"));
    await save();

    expect(screen.getByTestId("pro-profile-failure")).toHaveTextContent(
      "We couldn't use that photo. Choose another one.",
    );
    expect(valueOf("pro-profile-bio")).toBe("Plumber since 2014.");
    expect(photoStatus()).toBe("Use a clear, recent photo of yourself.");
    expect(router.back).not.toHaveBeenCalled();

    await save();
    expect(patches()).toEqual([
      { bio: "Plumber since 2014.", photo_key: PHOTO_KEY },
      { bio: "Plumber since 2014." },
    ]);
    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["offline", new NetworkError(false), OFFLINE],
    ["a timeout", new NetworkError(true), OFFLINE],
    ["a 5xx", new ApiError(503, undefined), "We couldn't save your profile. Try again."],
    ["a 4xx", new ApiError(422, "validation_error"), "We couldn't save your profile. Try again."],
  ])("%s on Save says so, keeps the form, and Save works again", async (_case, error, message) => {
    await open();
    await typed("pro-profile-bio", "Plumber since 2014.");
    jest.mocked(apiPatch).mockRejectedValueOnce(error);
    await save();

    expect(screen.getByTestId("pro-profile-failure")).toHaveTextContent(message);
    expect(announced()).toContain(message);
    expect(valueOf("pro-profile-bio")).toBe("Plumber since 2014.");
    expect(router.back).not.toHaveBeenCalled();

    await save();
    expect(apiPatch).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("pro-profile-failure")).toBeNull();
    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it("a choice the API no longer offers reloads the catalogs, and what they dropped leaves the form", async () => {
    await open();
    await typed("pro-profile-years", "13");
    jest.mocked(apiPatch).mockRejectedValueOnce(new ApiError(422, "invalid_category"));
    server.categories = [ELECTRICAL, PAINTING];
    await save();
    await flush();

    expect(screen.getByTestId("pro-profile-failure")).toHaveTextContent(
      "Some of your choices are no longer available. Review them and save again.",
    );
    expect(screen.queryByTestId("pro-profile-category-plumbing")).toBeNull();

    await save();
    expect(patches().at(-1)).toEqual({ years_of_experience: 13, category_ids: [] });
  });

  it("at the limit, no other ZIP code can be added until one is removed", async () => {
    jest.replaceProperty(proProfileConfig, "maxServiceAreas", 2);
    await open();

    expect(screen.getByText("That's the most you can choose.")).toBeTruthy();
    expect(stateOf("pro-profile-zip-33304").disabled).toBe(true);
    // The whole city would pass the limit.
    expect(stateOf("pro-profile-city-Fort Lauderdale").disabled).toBe(true);

    await pressed("pro-profile-zip-33324");
    expect(stateOf("pro-profile-zip-33304").disabled).toBe(false);
    await pressed("pro-profile-zip-33304");
    expect(isChosen("pro-profile-zip-33304")).toBe(true);
    expect(stateOf("pro-profile-zip-33305").disabled).toBe(true);
  });

  it("shows a layout-shaped placeholder while the profile loads", async () => {
    jest
      .mocked(apiGet)
      .mockImplementation((() => new Promise(() => undefined)) as unknown as typeof apiGet);
    await renderWithQuery(<ProProfileEditScreen />, client);

    expect(screen.getByLabelText("Loading your profile")).toBeTruthy();
    expect(screen.queryByTestId("pro-profile-save")).toBeNull();
  });

  it.each([
    ["offline", new NetworkError(false), OFFLINE],
    ["a 5xx", new ApiError(500, undefined), "Give it another try in a moment."],
    ["a 4xx", new ApiError(403, "forbidden"), "Give it another try in a moment."],
  ])("%s while loading says so with a retry that loads the form", async (_case, error, body) => {
    const working = jest.mocked(apiGet).getMockImplementation();
    jest.mocked(apiGet).mockImplementation((async (path: string) => {
      if (path === PROFILE) throw error;
      return path === "/v1/categories" ? server.categories : server.regions;
    }) as unknown as typeof apiGet);
    await renderWithQuery(<ProProfileEditScreen />, client);

    const notice = await screen.findByTestId("pro-profile-load-failed");
    expect(notice).toHaveTextContent(`We couldn't load your profile${body}Try again`);
    expect(screen.queryByTestId("pro-profile-save")).toBeNull();

    jest.mocked(apiGet).mockImplementation(working);
    await pressed("pro-profile-retry");
    expect(await screen.findByTestId("pro-profile-save")).toBeTruthy();
    expect(valueOf("pro-profile-bio")).toBe("Licensed plumber.");
  });
});
