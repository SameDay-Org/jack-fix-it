import { act, renderHook } from "@testing-library/react-native";
import * as ImagePicker from "expo-image-picker";

import {
  localFileSize,
  uploadMedia,
  UploadFailedError,
  UploadRejectedError,
  type UploadMediaOptions,
} from "@/api";

import { prepareMedia, type PickedMedia } from "../compress";
import { mediaConfig } from "../config";
import { MediaSizeUnknownError, MediaTooLargeError } from "../errors";
import { useMediaUpload, type MediaUploadOptions } from "../useMediaUpload";

jest.mock("expo-image-picker", () => ({
  requestCameraPermissionsAsync: jest.fn(),
  launchCameraAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(),
}));
// The real error classes (instanceof matters); the upload itself is driven by each test. The
// session boundary is a stand-in the tests move by hand (the real one: request/accountChange).
const mockSession = { generation: 1, forgetters: new Set<() => void>() };
jest.mock("@/api", () => ({
  ...jest.requireActual("@/api/errors"),
  uploadMedia: jest.fn(),
  localFileSize: jest.fn(),
  sessionGeneration: () => mockSession.generation,
  isCurrentGeneration: (startedIn: number) => startedIn === mockSession.generation,
  onSignOut: (forget: () => void) => {
    mockSession.forgetters.add(forget);
    return () => mockSession.forgetters.delete(forget);
  },
}));
jest.mock("../compress", () => ({ prepareMedia: jest.fn() }));

const picker = jest.mocked(ImagePicker);
const upload = jest.mocked(uploadMedia);
const prepare = jest.mocked(prepareMedia);
const fileSize = jest.mocked(localFileSize);

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
    ["sizeUnknown", () => new MediaSizeUnknownError()],
  ])("a %s failure is final: retry does nothing", async (failure, makeError) => {
    picker.launchImageLibraryAsync.mockResolvedValue(picked(asset(1, "video")));
    if (failure !== "rejected") prepare.mockRejectedValueOnce(makeError());
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

  // B2, with the real prepareMedia: whatever size the picker reports (none, Android's null, 0
  // from a NULL column, or a stale number), the video's size is the file's metadata.
  describe("a video's size comes from the file, whatever the picker reported", () => {
    const { prepareMedia: realPrepare } =
      jest.requireActual<typeof import("../compress")>("../compress");
    const max = mediaConfig.videoMaxBytes;

    beforeEach(() => prepare.mockImplementation((file) => realPrepare(file)));

    const addVideo = async (pickerSize: unknown) => {
      picker.launchImageLibraryAsync.mockResolvedValue(
        picked({ ...asset(1, "video"), fileSize: pickerSize as number | undefined }),
      );
      const rendered = await render();
      await act(() => rendered.result.current.add("library"));
      await flush();
      return rendered.result;
    };

    it.each([undefined, null, 0, 1024])(
      "picker size %p, file at the limit: uploaded",
      async (size) => {
        fileSize.mockReturnValue(max);

        const result = await addVideo(size);

        expect(fileSize).toHaveBeenCalledWith("file:///picked/1.mp4");
        expect(result.current.items[0]).toMatchObject({ status: "uploading", failure: null });
        expect(upload).toHaveBeenCalledTimes(1);
      },
    );

    it.each([undefined, null, 0, 1024])(
      "picker size %p, file one byte over: too large, never uploaded",
      async (size) => {
        fileSize.mockReturnValue(max + 1);

        const result = await addVideo(size);

        expect(result.current.items[0]).toMatchObject({ status: "failed", failure: "tooLarge" });
        expect(upload).not.toHaveBeenCalled();
      },
    );

    it("a size the file cannot tell: refused here, never uploaded", async () => {
      fileSize.mockReturnValue(null);

      const result = await addVideo(undefined);

      expect(result.current.items[0]).toMatchObject({ status: "failed", failure: "sizeUnknown" });
      expect(upload).not.toHaveBeenCalled();
    });
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

  it("unmounting stops the files still waiting their turn too", async () => {
    picker.launchImageLibraryAsync.mockResolvedValue(picked(asset(1), asset(2), asset(3)));
    const { result, unmount } = await render();
    await act(() => result.current.add("library"));
    await flush();
    expect(pending).toHaveLength(1);

    await unmount();
    await act(async () =>
      pending[0].reject(Object.assign(new Error("Aborted"), { name: "AbortError" })),
    );
    await flush();

    // Files 2 and 3 were never prepared nor uploaded.
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("unmounting while a file is being prepared uploads nothing", async () => {
    picker.launchImageLibraryAsync.mockResolvedValue(picked(asset(1)));
    let finishCompressing!: () => void;
    prepare.mockImplementationOnce(
      (file: PickedMedia) =>
        new Promise((resolve) => {
          finishCompressing = () =>
            resolve({ uri: `${file.uri}.compressed`, contentType: "image/jpeg", kind: file.kind });
        }),
    );
    const { result, unmount } = await render();
    await act(() => result.current.add("library"));

    await unmount();
    await act(async () => finishCompressing());
    await flush();

    expect(upload).not.toHaveBeenCalled();
  });

  it("unmounting cancels the upload in flight", async () => {
    picker.launchImageLibraryAsync.mockResolvedValue(picked(asset(1)));
    const { result, unmount } = await render();
    await act(() => result.current.add("library"));
    await flush();

    await unmount();

    expect(pending[0].options.signal?.aborted).toBe(true);
  });

  it("the same account signing in again: an item resumed under the new session waits for a retry", async () => {
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

    // A new session of the same account: no account boundary, so the list stays.
    mockSession.generation += 1;
    await act(async () => finishCompressing());
    await flush();

    expect(upload).not.toHaveBeenCalled();
    expect(result.current.items[0]).toMatchObject({ status: "failed", failure: "failed" });

    await act(async () => result.current.retry(result.current.items[0].id));
    await flush();
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledTimes(1);
    await act(async () => pending[0].resolve());
    expect(result.current.keys).toEqual([keyOf("file:///picked/1.jpg.compressed")]);
  });

  it("the account boundary cancels and drops everything, and the next account starts clean", async () => {
    picker.launchImageLibraryAsync.mockResolvedValue(picked(asset(1), asset(2)));
    const { result } = await render();
    await act(() => result.current.add("library"));
    await flush();
    await act(async () => pending[0].resolve());
    await flush();
    expect(result.current.keys).toHaveLength(1);

    await act(async () => {
      mockSession.generation += 1;
      mockSession.forgetters.forEach((forget) => forget());
    });

    expect(pending[1].options.signal?.aborted).toBe(true);
    expect(result.current.items).toEqual([]);
    expect(result.current.keys).toEqual([]);

    // A fresh queue: the next account's file does not wait behind the old account's work.
    picker.launchImageLibraryAsync.mockResolvedValue(picked(asset(3)));
    await act(() => result.current.add("library"));
    await flush();
    expect(upload).toHaveBeenCalledTimes(3);
    expect(pending[2].options.file.uri).toBe("file:///picked/3.jpg.compressed");
  });
});
