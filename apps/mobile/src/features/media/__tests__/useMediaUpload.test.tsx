import { act, renderHook } from "@testing-library/react-native";
import * as ImagePicker from "expo-image-picker";

import {
  uploadMedia,
  UploadFailedError,
  UploadRejectedError,
  type UploadMediaOptions,
} from "@/api";

import { prepareMedia, type PickedMedia } from "../compress";
import { MediaTooLargeError } from "../errors";
import { useMediaUpload, type MediaUploadOptions } from "../useMediaUpload";

jest.mock("expo-image-picker", () => ({
  requestCameraPermissionsAsync: jest.fn(),
  launchCameraAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(),
}));
// The real error classes (instanceof matters); the upload itself is driven by each test.
jest.mock("@/api", () => ({ ...jest.requireActual("@/api/errors"), uploadMedia: jest.fn() }));
jest.mock("../compress", () => ({ prepareMedia: jest.fn() }));

const picker = jest.mocked(ImagePicker);
const upload = jest.mocked(uploadMedia);
const prepare = jest.mocked(prepareMedia);

const asset = (n: number, type: "image" | "video" = "image"): ImagePicker.ImagePickerAsset => ({
  uri: `file:///picked/${n}.${type === "image" ? "jpg" : "mp4"}`,
  width: 4032,
  height: 3024,
  type,
  mimeType: type === "image" ? "image/jpeg" : "video/mp4",
  fileSize: 3_000_000,
});
const picked = (...assets: ImagePicker.ImagePickerAsset[]) =>
  ({ canceled: false, assets }) as ImagePicker.ImagePickerResult;
const keyOf = (uri: string) =>
  `u/user/request_media/${uri.replace(/\D/g, "").padStart(32, "0")}.jpg`;

/** Uploads the test settles by hand, in the order they started. */
type Pending = {
  options: UploadMediaOptions;
  resolve: () => void;
  reject: (error: unknown) => void;
};
let pending: Pending[];

const flush = () => act(async () => new Promise<void>((resolve) => setTimeout(resolve, 0)));
const render = (options: Partial<MediaUploadOptions> = {}) =>
  renderHook(() => useMediaUpload({ purpose: "request_media", max: 10, ...options }));

beforeEach(() => {
  jest.clearAllMocks();
  pending = [];
  prepare.mockImplementation(async (file: PickedMedia) => ({
    uri: `${file.uri}.compressed`,
    contentType: "image/jpeg",
    kind: file.kind,
  }));
  upload.mockImplementation(
    (options) =>
      new Promise((resolve, reject) => {
        pending.push({
          options,
          resolve: () => resolve({ key: keyOf(options.file.uri) }),
          reject,
        });
      }),
  );
  picker.requestCameraPermissionsAsync.mockResolvedValue({
    granted: true,
  } as ImagePicker.CameraPermissionResponse);
});

describe("useMediaUpload", () => {
  it("opens the library for photos and videos on request media, as many as still fit", async () => {
    picker.launchImageLibraryAsync.mockResolvedValue({ canceled: true, assets: null });
    const { result } = await render({ max: 4 });

    await act(() => result.current.add("library"));

    expect(picker.launchImageLibraryAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaTypes: ["images", "videos"],
        allowsMultipleSelection: true,
        selectionLimit: 4,
        exif: false,
      }),
    );
    expect(result.current.items).toEqual([]);
  });

  it("offers photos only for the other purposes", async () => {
    picker.launchImageLibraryAsync.mockResolvedValue({ canceled: true, assets: null });
    const { result } = await render({ purpose: "profile_photo" });

    await act(() => result.current.add("library"));

    expect(picker.launchImageLibraryAsync).toHaveBeenCalledWith(
      expect.objectContaining({ mediaTypes: ["images"] }),
    );
  });

  it("each file goes compressing, uploading with progress, done with its key", async () => {
    picker.launchImageLibraryAsync.mockResolvedValue(picked(asset(1)));
    let finishCompressing!: () => void;
    prepare.mockImplementationOnce(
      (file: PickedMedia) =>
        new Promise((resolve) => {
          finishCompressing = () =>
            resolve({ uri: `${file.uri}.compressed`, contentType: "image/jpeg", kind: file.kind });
        }),
    );
    const { result } = await render();

    await act(() => result.current.add("library"));
    expect(result.current.items[0]).toMatchObject({ status: "compressing", kind: "image" });
    await act(async () => finishCompressing());
    await flush();

    expect(result.current.items[0]).toMatchObject({ status: "uploading", progress: 0 });
    expect(pending[0].options).toMatchObject({
      purpose: "request_media",
      file: { uri: "file:///picked/1.jpg.compressed", contentType: "image/jpeg" },
    });
    await act(async () => pending[0].options.onProgress?.(0.4));
    expect(result.current.items[0].progress).toBe(0.4);

    await act(async () => pending[0].resolve());
    expect(result.current.items[0]).toMatchObject({
      status: "done",
      progress: 1,
      key: keyOf("file:///picked/1.jpg.compressed"),
    });
    expect(result.current.keys).toEqual([keyOf("file:///picked/1.jpg.compressed")]);
  });

  it("handles one file at a time, in the order they were picked", async () => {
    picker.launchImageLibraryAsync.mockResolvedValue(picked(asset(1), asset(2)));
    const { result } = await render();

    await act(() => result.current.add("library"));
    await flush();

    expect(prepare).toHaveBeenCalledTimes(1);
    expect(result.current.items.map((item) => item.status)).toEqual(["uploading", "compressing"]);

    await act(async () => pending[0].resolve());
    await flush();
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(result.current.items.map((item) => item.status)).toEqual(["done", "uploading"]);
  });

  it("never holds more than the max: extra picks are dropped and the picker stays shut", async () => {
    picker.launchImageLibraryAsync.mockResolvedValue(
      picked(asset(1), asset(2), asset(3), asset(4)),
    );
    const { result } = await render({ max: 3 });

    await act(() => result.current.add("library"));

    expect(result.current.items).toHaveLength(3);
    expect(result.current.remaining).toBe(0);
    picker.launchImageLibraryAsync.mockClear();
    await act(() => result.current.add("library"));
    await act(() => result.current.add("camera"));
    expect(picker.launchImageLibraryAsync).not.toHaveBeenCalled();
    expect(picker.launchCameraAsync).not.toHaveBeenCalled();
  });

  it("a failed upload can be retried, without preparing the file again", async () => {
    picker.launchImageLibraryAsync.mockResolvedValue(picked(asset(1)));
    const { result } = await render();
    await act(() => result.current.add("library"));
    await flush();

    await act(async () => pending[0].reject(new UploadFailedError("network")));
    expect(result.current.items[0]).toMatchObject({ status: "failed", failure: "failed" });

    await act(async () => result.current.retry(result.current.items[0].id));
    await flush();
    expect(result.current.items[0]).toMatchObject({ status: "uploading", failure: null });
    expect(prepare).toHaveBeenCalledTimes(1);

    await act(async () => pending[1].resolve());
    expect(result.current.items[0].status).toBe("done");
  });

  it.each([
    ["rejected", () => new UploadRejectedError(422, "upload_invalid")],
    ["tooLarge", () => new MediaTooLargeError(100)],
  ])("a %s failure is final: retry does nothing", async (failure, makeError) => {
    picker.launchImageLibraryAsync.mockResolvedValue(picked(asset(1, "video")));
    if (failure === "tooLarge") prepare.mockRejectedValueOnce(makeError());
    const { result } = await render();
    await act(() => result.current.add("library"));
    await flush();
    if (failure === "rejected") await act(async () => pending[0].reject(makeError()));

    expect(result.current.items[0]).toMatchObject({ status: "failed", failure, kind: "video" });
    const uploads = upload.mock.calls.length;
    await act(async () => result.current.retry(result.current.items[0].id));
    await flush();
    expect(result.current.items[0].status).toBe("failed");
    expect(upload).toHaveBeenCalledTimes(uploads);
  });

  it("removing an item cancels its upload and frees its place", async () => {
    picker.launchImageLibraryAsync.mockResolvedValue(picked(asset(1), asset(2)));
    const { result } = await render({ max: 2 });
    await act(() => result.current.add("library"));
    await flush();
    const { signal } = pending[0].options;

    await act(async () => result.current.remove(result.current.items[0].id));

    expect(signal?.aborted).toBe(true);
    expect(result.current.items.map((item) => item.previewUri)).toEqual(["file:///picked/2.jpg"]);
    expect(result.current.remaining).toBe(1);
    // The cancelled upload's rejection changes nothing; the next file takes its turn.
    await act(async () =>
      pending[0].reject(Object.assign(new Error("Aborted"), { name: "AbortError" })),
    );
    await flush();
    expect(result.current.items).toEqual([
      expect.objectContaining({ previewUri: "file:///picked/2.jpg", status: "uploading" }),
    ]);
  });

  it("camera refused: no camera, and the notice until dismissed", async () => {
    picker.requestCameraPermissionsAsync.mockResolvedValue({
      granted: false,
      canAskAgain: false,
    } as ImagePicker.CameraPermissionResponse);
    const { result } = await render();

    await act(() => result.current.add("camera"));

    expect(picker.launchCameraAsync).not.toHaveBeenCalled();
    expect(result.current.permissionDenied).toBe("camera");
    expect(result.current.picking).toBe(false);
    await act(async () => result.current.dismissPermissionNotice());
    expect(result.current.permissionDenied).toBeNull();
  });

  it("camera allowed: one photo, uploaded like the rest", async () => {
    picker.launchCameraAsync.mockResolvedValue(picked(asset(7)));
    const { result } = await render();

    await act(() => result.current.add("camera"));
    await flush();

    expect(picker.launchCameraAsync).toHaveBeenCalledWith({ mediaTypes: ["images"], exif: false });
    expect(result.current.items[0]).toMatchObject({ status: "uploading" });
  });

  it("unmounting cancels the upload in flight", async () => {
    picker.launchImageLibraryAsync.mockResolvedValue(picked(asset(1)));
    const { result, unmount } = await render();
    await act(() => result.current.add("library"));
    await flush();

    await unmount();

    expect(pending[0].options.signal?.aborted).toBe(true);
  });
});
