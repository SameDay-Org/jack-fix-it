import "@/i18n";

import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { router } from "expo-router";
import { AccessibilityInfo, Linking } from "react-native";

import { showToast } from "@/components/ui";

import { MediaItemRow } from "../MediaItemRow";
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
jest.mock("@/components/ui", () => ({
  ...jest.requireActual("@/components/ui"),
  showToast: jest.fn(),
}));
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

let announce: jest.SpyInstance;
beforeEach(() => {
  jest.clearAllMocks();
  announce = jest
    .spyOn(AccessibilityInfo, "announceForAccessibility")
    .mockImplementation(() => undefined);
});
afterEach(() => announce.mockRestore());

describe("MediaPicker", () => {
  it("empty: says what to add, and the one primary action adds it", async () => {
    await renderPicker(makeUpload());

    expect(screen.getByText("No photos or videos yet")).toBeTruthy();
    expect(screen.getByText("Add up to 10 photos or videos.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add photos or videos" })).toBeTruthy();
  });

  it("photos only for a purpose without videos", async () => {
    await renderPicker(makeUpload({ acceptsVideo: false, max: 1 }));

    expect(screen.getByText("No photos yet")).toBeTruthy();
    expect(screen.getByText("Add up to 1 photos.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add photos" })).toBeTruthy();
  });

  it("each item shows its status; a retryable failure offers Retry, every item Remove", async () => {
    const upload = makeUpload({
      items: [
        item(1, { status: "done", progress: 1, key: "k" }),
        item(2),
        item(3, { status: "failed", failure: "failed" }),
        item(4, { kind: "video", status: "failed", failure: "tooLarge" }),
        item(5, { kind: "video", status: "failed", failure: "sizeUnknown" }),
      ],
      remaining: 5,
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
    expect(screen.getByTestId("media-item-4-status")).toHaveTextContent(
      "We couldn't check this video's size, so it can't be uploaded. Try another video.",
    );
    // Each action says which file it acts on.
    expect(screen.getByRole("button", { name: "Retry Photo 3" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /^Retry/ })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Remove Video 4" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /^Remove/ })).toHaveLength(5);
    // The video tile says what it is (the tile is hidden from assistive technology: the row speaks).
    expect(screen.getAllByText("Video", { includeHiddenElements: true })).toHaveLength(2);
    expect(screen.getByTestId("media-count")).toHaveTextContent("5 of 10 added");

    await fireEvent.press(screen.getByRole("button", { name: "Retry Photo 3" }));
    expect(upload.retry).toHaveBeenCalledWith("media-3");
    await fireEvent.press(screen.getByRole("button", { name: "Remove Photo 2" }));
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
    expect(announce).toHaveBeenCalledWith(
      "Camera access is off. To take photos here, allow camera access in Settings.",
    );
    expect(screen.getByText("To take photos here, allow camera access in Settings.")).toBeTruthy();

    await fireEvent.press(screen.getByRole("button", { name: "Open settings" }));
    expect(openSettings).toHaveBeenCalledTimes(1);
    expect(upload.dismissPermissionNotice).toHaveBeenCalled();

    await fireEvent.press(screen.getByRole("button", { name: "Not now" }));
    expect(upload.dismissPermissionNotice).toHaveBeenCalledTimes(2);
  });

  it("Add asks camera or library; the picker opens over the sheet, which closes after", async () => {
    let finishPicking!: () => void;
    const upload = makeUpload({
      add: jest.fn(() => new Promise<void>((resolve) => (finishPicking = resolve))),
    });
    await renderPicker(upload);

    await fireEvent.press(screen.getByRole("button", { name: "Add photos or videos" }));
    expect(router.push).toHaveBeenCalledWith("/dev/media-source");

    const sheet = await render(<MediaSourceSheet />);
    expect(sheet.getByText("Add photos or videos")).toBeTruthy(); // the sheet speaks of videos too
    await fireEvent.press(sheet.getByRole("button", { name: "Choose from library" }));

    // The library opens while the sheet is still up; the sheet goes once the picker returns.
    expect(upload.add).toHaveBeenCalledWith("library");
    expect(router.back).not.toHaveBeenCalled();
    await act(async () => finishPicking());
    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it("a sheet closed without a choice adds nothing and closes nothing more", async () => {
    const upload = makeUpload();
    await renderPicker(upload);
    await fireEvent.press(screen.getByRole("button", { name: "Add photos or videos" }));

    const sheet = await render(<MediaSourceSheet />);
    await act(async () => sheet.unmount());

    expect(upload.add).not.toHaveBeenCalled();
    expect(router.back).not.toHaveBeenCalled();
  });

  it("a second tap while the sheet opens opens nothing more", async () => {
    await renderPicker(makeUpload());

    const add = screen.getByRole("button", { name: "Add photos or videos" });
    await fireEvent.press(add);
    await fireEvent.press(screen.getByTestId("media-add"));

    expect(router.push).toHaveBeenCalledTimes(1);
  });

  it("a camera or picker that fails to open says so", async () => {
    const upload = makeUpload({ add: jest.fn(async () => Promise.reject(new Error("native"))) });
    await renderPicker(upload);
    await fireEvent.press(screen.getByRole("button", { name: "Add photos or videos" }));
    const sheet = await render(<MediaSourceSheet />);

    await act(async () => fireEvent.press(sheet.getByRole("button", { name: "Take a photo" })));

    expect(showToast).toHaveBeenCalledWith({
      message: "Couldn't open the camera or your photos. Try again.",
      tone: "danger",
    });
    expect(router.back).toHaveBeenCalledTimes(1);
  });
});

describe("MediaItemRow", () => {
  it("announces the outcome once, never each progress step", async () => {
    const view = await render(
      <MediaItemRow item={item(1)} index={0} onRetry={jest.fn()} onRemove={jest.fn()} />,
    );
    await view.rerender(
      <MediaItemRow
        item={item(1, { progress: 0.8 })}
        index={0}
        onRetry={jest.fn()}
        onRemove={jest.fn()}
      />,
    );
    expect(announce).not.toHaveBeenCalled();

    await view.rerender(
      <MediaItemRow
        item={item(1, { status: "done", progress: 1, key: "k" })}
        index={0}
        onRetry={jest.fn()}
        onRemove={jest.fn()}
      />,
    );
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith("Photo 1: Uploaded");
  });
});
