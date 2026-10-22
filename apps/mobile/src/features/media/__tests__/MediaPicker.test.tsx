import "@/i18n";

import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { router } from "expo-router";
import { Linking } from "react-native";

import { MediaPicker } from "../MediaPicker";
import { MediaSourceSheet } from "../MediaSourceSheet";
import type { MediaItem, MediaUpload } from "../useMediaUpload";

jest.mock(
  "../../../api/config",
  () => jest.requireActual("../../../api/__tests__/helpers").configMock,
);
jest.mock(
  "expo-secure-store",
  () => jest.requireActual("../../../api/__tests__/helpers").secureStoreMock,
);
jest.mock("expo-image-picker", () => ({}));
jest.mock("expo-image-manipulator", () => ({}));
jest.mock("expo-router", () => ({ router: { push: jest.fn(), back: jest.fn() } }));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);
jest.mock("expo-glass-effect", () => ({
  GlassView: () => null,
  isLiquidGlassAvailable: () => false,
  isGlassEffectAPIAvailable: () => false,
}));

const item = (n: number, patch: Partial<MediaItem> = {}): MediaItem => ({
  id: `media-${n}`,
  kind: "image",
  previewUri: `file:///picked/${n}.jpg`,
  status: "uploading",
  progress: 0.4,
  key: null,
  failure: null,
  ...patch,
});

const makeUpload = (patch: Partial<MediaUpload> = {}): MediaUpload => ({
  items: [],
  max: 10,
  acceptsVideo: true,
  keys: [],
  remaining: 10,
  picking: false,
  permissionDenied: null,
  dismissPermissionNotice: jest.fn(),
  add: jest.fn(async () => undefined),
  retry: jest.fn(),
  remove: jest.fn(),
  ...patch,
});

const renderPicker = (upload: MediaUpload) =>
  render(<MediaPicker upload={upload} sourceSheet="/dev/media-source" />);

beforeEach(() => jest.clearAllMocks());

describe("MediaPicker", () => {
  it("empty: says what to add, and the one primary action adds it", async () => {
    await renderPicker(makeUpload());

    expect(screen.getByText("No photos yet")).toBeTruthy();
    expect(screen.getByText("Add up to 10 photos or videos.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add photos" })).toBeTruthy();
  });

  it("photos only for a purpose without videos", async () => {
    await renderPicker(makeUpload({ acceptsVideo: false, max: 1 }));

    expect(screen.getByText("Add up to 1 photos.")).toBeTruthy();
  });

  it("each item shows its status; a retryable failure offers Retry, every item Remove", async () => {
    const upload = makeUpload({
      items: [
        item(1, { status: "done", progress: 1, key: "k" }),
        item(2),
        item(3, { status: "failed", failure: "failed" }),
        item(4, { kind: "video", status: "failed", failure: "tooLarge" }),
      ],
      remaining: 6,
    });
    await renderPicker(upload);

    expect(screen.getByText("Photo 1")).toBeTruthy();
    expect(screen.getByTestId("media-item-0-status")).toHaveTextContent("Uploaded");
    expect(screen.getByTestId("media-item-1-status")).toHaveTextContent("Uploading… 40%");
    expect(screen.getByTestId("media-item-2-status")).toHaveTextContent(
      "Upload failed. Check your connection and try again.",
    );
    expect(screen.getByText("Video 4")).toBeTruthy();
    expect(screen.getByTestId("media-item-3-status")).toHaveTextContent(
      "This video is over 100 MB.",
    );
    expect(screen.getAllByRole("button", { name: "Retry" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Remove" })).toHaveLength(4);
    expect(screen.getByTestId("media-count")).toHaveTextContent("4 of 10 added");

    await fireEvent.press(screen.getByRole("button", { name: "Retry" }));
    expect(upload.retry).toHaveBeenCalledWith("media-3");
    await fireEvent.press(screen.getAllByRole("button", { name: "Remove" })[1]);
    expect(upload.remove).toHaveBeenCalledWith("media-2");
  });

  it("at the limit, Add is disabled and the count says so", async () => {
    await renderPicker(makeUpload({ items: [item(1)], max: 1, remaining: 0 }));

    expect(screen.getByRole("button", { name: "Add more" })).toBeDisabled();
    expect(screen.getByTestId("media-count")).toHaveTextContent("That's the most you can add.");
  });

  it("camera refused: the explanation, and Open settings goes to the device settings", async () => {
    const openSettings = jest.spyOn(Linking, "openSettings").mockResolvedValue(undefined);
    const upload = makeUpload({ permissionDenied: "camera" });
    await renderPicker(upload);

    expect(screen.getByText("Camera access is off")).toBeTruthy();
    expect(screen.getByText("To take photos here, allow camera access in Settings.")).toBeTruthy();

    await fireEvent.press(screen.getByRole("button", { name: "Open settings" }));
    expect(openSettings).toHaveBeenCalledTimes(1);
    expect(upload.dismissPermissionNotice).toHaveBeenCalled();

    await fireEvent.press(screen.getByRole("button", { name: "Not now" }));
    expect(upload.dismissPermissionNotice).toHaveBeenCalledTimes(2);
  });

  it("Add asks camera or library in the sheet, then adds from the chosen source", async () => {
    const upload = makeUpload();
    await renderPicker(upload);

    await fireEvent.press(screen.getByRole("button", { name: "Add photos" }));
    expect(router.push).toHaveBeenCalledWith("/dev/media-source");

    // The sheet route: choosing closes it; the choice lands once it is gone.
    const sheet = await render(<MediaSourceSheet />);
    await fireEvent.press(sheet.getByRole("button", { name: "Choose from library" }));
    expect(router.back).toHaveBeenCalled();
    expect(upload.add).not.toHaveBeenCalled();
    await act(async () => sheet.unmount());

    expect(upload.add).toHaveBeenCalledWith("library");
  });

  it("a sheet closed without a choice adds nothing", async () => {
    const upload = makeUpload();
    await renderPicker(upload);
    await fireEvent.press(screen.getByRole("button", { name: "Add photos" }));

    const sheet = await render(<MediaSourceSheet />);
    await act(async () => sheet.unmount());

    expect(upload.add).not.toHaveBeenCalled();
  });
});
