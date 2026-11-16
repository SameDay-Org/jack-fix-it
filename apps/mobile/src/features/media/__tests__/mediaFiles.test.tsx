import { act, renderHook } from "@testing-library/react-native";
import * as ImagePicker from "expo-image-picker";

import { uploadMedia, UploadRejectedError, type UploadMediaOptions } from "@/api";

import { deferred } from "../../../api/__tests__/helpers";
import { prepareMedia, type PickedMedia, type PreparedMedia } from "../compress";
import { useMediaUpload, type MediaUploadOptions } from "../useMediaUpload";

jest.mock("expo-image-picker", () => ({
  requestCameraPermissionsAsync: jest.fn(),
  launchCameraAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(),
}));
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
// The phone's disk, as the files the app sees: what exists, and what was deleted.
const mockDisk = { files: new Set<string>(), deleted: [] as string[] };
jest.mock("expo-file-system", () => ({
  Paths: { cache: { uri: "file:///data/app/cache/" } },
  File: class {
    mockUri: string;
    constructor(mockUri: string) {
      this.mockUri = mockUri;
    }
    get exists() {
      return mockDisk.files.has(this.mockUri);
    }
    delete() {
      mockDisk.files.delete(this.mockUri);
      mockDisk.deleted.push(this.mockUri);
    }
  },
}));

const CACHE = "file:///data/app/cache/";
/** The picker's copy of photo `n`, in the app's cache (where expo-image-picker writes it). */
const pickedUri = (n: number) => `${CACHE}ImagePicker/${n}.jpg`;
/** Its compressed JPEG, in the app's cache (where expo-image-manipulator writes it). */
const compressedUri = (n: number) => `${CACHE}ImageManipulator/${n}.jpg`;
/** A picture in the user's library, outside the app's cache: never the app's to delete. */
const LIBRARY = "file:///storage/emulated/0/DCIM/Camera/IMG_0001.jpg";

const picker = jest.mocked(ImagePicker);
const upload = jest.mocked(uploadMedia);
const prepare = jest.mocked(prepareMedia);

const pick = (uri: string) => {
  // The picker writes its copy before it hands it over.
  mockDisk.files.add(uri);
  picker.launchImageLibraryAsync.mockResolvedValueOnce({
    canceled: false,
    assets: [{ uri, width: 800, height: 600, type: "image", mimeType: "image/jpeg" }],
  } as ImagePicker.ImagePickerResult);
};

type Pending = { options: UploadMediaOptions; resolve: () => void; reject: (e: unknown) => void };
let uploads: Pending[];
const flush = () => act(async () => new Promise<void>((resolve) => setTimeout(resolve, 0)));
const render = (options: Partial<MediaUploadOptions> = {}) =>
  renderHook(() =>
    useMediaUpload({
      purpose: "pro_document",
      max: 1,
      replace: true,
      discardFiles: true,
      ...options,
    }),
  );
const onDisk = () => [...mockDisk.files].sort();

beforeEach(() => {
  jest.clearAllMocks();
  mockSession.generation = 1;
  mockSession.forgetters.clear();
  mockDisk.files.clear();
  mockDisk.deleted = [];
  uploads = [];
  // Compression writes a new JPEG next to the picker's copy.
  prepare.mockImplementation(async (file: PickedMedia): Promise<PreparedMedia> => {
    const n = Number(file.uri.replace(/\D/g, "").slice(-1));
    const uri = file.uri === LIBRARY ? `${CACHE}ImageManipulator/library.jpg` : compressedUri(n);
    mockDisk.files.add(uri);
    return { uri, contentType: "image/jpeg", kind: "image" };
  });
  upload.mockImplementation(
    (options) =>
      new Promise((resolve, reject) => {
        // As the real upload does: a cancelled one rejects at once.
        options.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        uploads.push({ options, resolve: () => resolve({ key: "u/pro_document/1.jpg" }), reject });
      }),
  );
});

/** Picks photo `n` and lets it compress; its upload is left open. */
async function choose(result: { current: ReturnType<typeof useMediaUpload> }, n: number) {
  pick(pickedUri(n));
  await act(() => result.current.add("library"));
  await flush();
}

describe("a document photo's files (discardFiles)", () => {
  it("the compressed copy goes once the storage has it; the picked copy stays for the preview", async () => {
    const { result } = await render();
    await choose(result, 1);
    expect(onDisk()).toEqual([compressedUri(1), pickedUri(1)]);

    await act(async () => uploads[0].resolve());
    expect(result.current.items[0].status).toBe("done");
    expect(onDisk()).toEqual([pickedUri(1)]);
  });

  it("leaving the screen deletes both", async () => {
    const { result, unmount } = await render();
    await choose(result, 1);
    await act(async () => uploads[0].resolve());

    await act(async () => unmount());
    expect(onDisk()).toEqual([]);
    expect(mockDisk.deleted.sort()).toEqual([compressedUri(1), pickedUri(1)]);
  });

  it("a photo chosen again deletes the one it replaces, and keeps its own", async () => {
    const { result } = await render();
    await choose(result, 1);
    await choose(result, 2);

    expect(onDisk()).toEqual([compressedUri(2), pickedUri(2)]);
  });

  it("a photo set aside (removed) deletes its files", async () => {
    const { result } = await render();
    await choose(result, 1);

    await act(async () => result.current.remove(result.current.items[0].id));
    expect(onDisk()).toEqual([]);
  });

  it("a sign-out (or another account) deletes them", async () => {
    const { result } = await render();
    await choose(result, 1);

    await act(async () => mockSession.forgetters.forEach((forget) => forget()));
    expect(onDisk()).toEqual([]);
  });

  it("a compression that ends after the photo was set aside deletes its result", async () => {
    const late = deferred<PreparedMedia>();
    prepare.mockImplementationOnce(() => late.promise);
    const { result } = await render();
    pick(pickedUri(1));
    await act(() => result.current.add("library"));
    await act(async () => result.current.remove(result.current.items[0].id));
    expect(onDisk()).toEqual([]);

    // The compressed JPEG is written after all, and goes as soon as it is handed over.
    mockDisk.files.add(compressedUri(1));
    await act(async () =>
      late.resolve({ uri: compressedUri(1), contentType: "image/jpeg", kind: "image" }),
    );
    await flush();
    expect(onDisk()).toEqual([]);
    expect(upload).not.toHaveBeenCalled();
  });

  it("a failed upload keeps its file for the retry; the retry's success deletes it", async () => {
    const { result } = await render();
    await choose(result, 1);
    await act(async () => uploads[0].reject(new Error("offline")));
    expect(result.current.items[0].failure).toBe("failed");
    expect(onDisk()).toEqual([compressedUri(1), pickedUri(1)]);

    await act(async () => result.current.retry(result.current.items[0].id));
    await flush();
    // The retry uploads the same compressed file: it was not compressed again.
    expect(uploads[1].options.file.uri).toBe(compressedUri(1));
    expect(prepare).toHaveBeenCalledTimes(1);
    await act(async () => uploads[1].resolve());
    expect(onDisk()).toEqual([pickedUri(1)]);
  });

  it("a retry abandoned (the photo set aside) deletes the file it kept", async () => {
    const { result } = await render();
    await choose(result, 1);
    await act(async () => uploads[0].reject(new Error("offline")));

    await act(async () => result.current.remove(result.current.items[0].id));
    expect(onDisk()).toEqual([]);
  });

  it("a refusal no retry can mend deletes the compressed copy at once", async () => {
    const { result } = await render();
    await choose(result, 1);
    await act(async () => uploads[0].reject(new UploadRejectedError(415, "unsupported_media")));

    expect(result.current.items[0].failure).toBe("rejected");
    expect(onDisk()).toEqual([pickedUri(1)]);
  });

  /** Opens the picker and holds its answer: the copy is written when the picker hands it over. */
  async function openPickerHeld(result: { current: ReturnType<typeof useMediaUpload> }) {
    const answer = deferred<ImagePicker.ImagePickerResult>();
    picker.launchImageLibraryAsync.mockReturnValueOnce(answer.promise);
    let adding: Promise<void> | undefined;
    await act(async () => {
      adding = result.current.add("library");
    });
    return {
      handOver: async (uri: string) => {
        mockDisk.files.add(uri);
        await act(async () => {
          answer.resolve({
            canceled: false,
            assets: [{ uri, width: 800, height: 600, type: "image", mimeType: "image/jpeg" }],
          } as ImagePicker.ImagePickerResult);
          await adding;
        });
      },
    };
  }

  it("a picker that answers after the screen left: its copy is deleted, nothing is prepared", async () => {
    const { result, unmount } = await render();
    const held = await openPickerHeld(result);

    await act(async () => unmount());
    await held.handOver(pickedUri(1));
    expect(onDisk()).toEqual([]);
    expect(mockDisk.deleted).toEqual([pickedUri(1)]);
    expect(prepare).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  it("a picker that answers after a sign-out (or another account): its copy is deleted", async () => {
    const { result } = await render();
    const held = await openPickerHeld(result);

    await act(async () => {
      mockSession.generation += 1;
      mockSession.forgetters.forEach((forget) => forget());
    });
    await held.handOver(pickedUri(1));
    expect(onDisk()).toEqual([]);
    expect(result.current.items).toEqual([]);
    expect(prepare).not.toHaveBeenCalled();
  });

  it("a late picker answer never deletes a picture outside the app's cache", async () => {
    const { result, unmount } = await render();
    const held = await openPickerHeld(result);

    await act(async () => unmount());
    await held.handOver(LIBRARY);
    expect(mockDisk.files.has(LIBRARY)).toBe(true);
  });

  it("never deletes a picture outside the app's cache (a library original)", async () => {
    const { result, unmount } = await render();
    pick(LIBRARY);
    await act(() => result.current.add("library"));
    await flush();

    await act(async () => result.current.remove(result.current.items[0].id));
    await act(async () => unmount());
    expect(mockDisk.files.has(LIBRARY)).toBe(true);
    expect(mockDisk.deleted).not.toContain(LIBRARY);
  });
});

describe("other photos (no discardFiles: profile photo, job photos, request media)", () => {
  it("keep a late picker answer's copy as before", async () => {
    const answer = deferred<ImagePicker.ImagePickerResult>();
    picker.launchImageLibraryAsync.mockReturnValueOnce(answer.promise);
    const { result, unmount } = await render({ discardFiles: false });
    let adding: Promise<void> | undefined;
    await act(async () => {
      adding = result.current.add("library");
    });
    await act(async () => unmount());
    mockDisk.files.add(pickedUri(1));
    await act(async () => {
      answer.resolve({
        canceled: false,
        assets: [{ uri: pickedUri(1), width: 800, height: 600, type: "image" }],
      } as ImagePicker.ImagePickerResult);
      await adding;
    });
    expect(mockDisk.deleted).toEqual([]);
  });

  it("keep their files as before", async () => {
    const { result, unmount } = await render({ discardFiles: false });
    await choose(result, 1);
    await act(async () => uploads[0].resolve());
    await choose(result, 2);
    await act(async () => mockSession.forgetters.forEach((forget) => forget()));
    await act(async () => unmount());

    expect(mockDisk.deleted).toEqual([]);
  });
});
