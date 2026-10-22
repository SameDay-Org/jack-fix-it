import { ImageManipulator, SaveFormat } from "expo-image-manipulator";

import { compressImage, prepareMedia } from "../compress";
import type { MediaConfig } from "../config";
import { MediaTooLargeError, UnsupportedMediaError } from "../errors";

// The manipulator, recorded: what it was asked to load, resize and save, and what it released.
type MockRef = {
  width: number;
  height: number;
  saveAsync: jest.Mock;
  release: jest.Mock;
};
type MockContext = {
  source: unknown;
  resize: jest.Mock;
  renderAsync: jest.Mock;
  release: jest.Mock;
};
const mockContexts: MockContext[] = [];
let mockDecoded = { width: 0, height: 0 };

jest.mock("expo-image-manipulator", () => {
  const ref = (width: number, height: number, name: string): MockRef => ({
    width,
    height,
    saveAsync: jest.fn(async () => ({ uri: `file:///cache/${name}.jpg`, width, height })),
    release: jest.fn(),
  });
  return {
    SaveFormat: { JPEG: "jpeg", PNG: "png", WEBP: "webp" },
    ImageManipulator: {
      manipulate: jest.fn((source: unknown) => {
        const context: MockContext = {
          source,
          resize: jest.fn(),
          renderAsync: jest.fn(),
          release: jest.fn(),
        };
        context.resize.mockImplementation(
          ({ width, height }: { width?: number; height?: number }) => {
            // What the native side does with one side given: the other follows the aspect ratio.
            const scale = width ? width / mockDecoded.width : (height ?? 0) / mockDecoded.height;
            context.renderAsync.mockResolvedValue(
              ref(
                Math.round(mockDecoded.width * scale),
                Math.round(mockDecoded.height * scale),
                "resized",
              ),
            );
            return context;
          },
        );
        context.renderAsync.mockResolvedValue(
          typeof source === "string"
            ? ref(mockDecoded.width, mockDecoded.height, "decoded")
            : source,
        );
        mockContexts.push(context);
        return context;
      }),
    },
  };
});

const CONFIG: MediaConfig = {
  imageMaxEdge: 2048,
  imageQuality: 0.8,
  videoMaxBytes: 100 * 1024 * 1024,
  requestMediaMax: 10,
};
const ORIGINAL = "file:///picker/IMG_0001.HEIC";

const savedFrom = async (): Promise<MockRef> => {
  // The ref whose saveAsync ran: the decoded one, or the resized one.
  const refs = await Promise.all(
    mockContexts.map((context) => context.renderAsync.mock.results[0]?.value as Promise<MockRef>),
  );
  const saved = refs.filter(Boolean).find((ref) => ref.saveAsync.mock.calls.length > 0);
  if (!saved) throw new Error("nothing was saved");
  return saved;
};

beforeEach(() => {
  mockContexts.length = 0;
  jest.mocked(ImageManipulator.manipulate).mockClear();
});

describe("compressImage", () => {
  it.each([
    ["landscape", 4032, 3024, { width: 2048 }, [2048, 1536]],
    ["portrait", 3024, 4032, { height: 2048 }, [1536, 2048]],
  ])(
    "%s: brings the long edge down to the max, keeping the aspect ratio",
    async (_, width, height, resize, [outWidth, outHeight]) => {
      mockDecoded = { width, height };

      await compressImage(ORIGINAL, CONFIG);

      const resizes = mockContexts.flatMap((context) => context.resize.mock.calls);
      expect(resizes).toEqual([[resize]]);
      const saved = await savedFrom();
      expect([saved.width, saved.height]).toEqual([outWidth, outHeight]);
      expect(saved.width / saved.height).toBeCloseTo(width / height, 2);
    },
  );

  it("re-encodes as JPEG at the configured quality", async () => {
    mockDecoded = { width: 4032, height: 3024 };

    const uri = await compressImage(ORIGINAL, { imageMaxEdge: 2048, imageQuality: 0.6 });

    const saved = await savedFrom();
    expect(saved.saveAsync).toHaveBeenCalledWith({ format: SaveFormat.JPEG, compress: 0.6 });
    expect(uri).toBe("file:///cache/resized.jpg");
  });

  it("re-encodes a small image too, so no EXIF (GPS included) or HEIC survives", async () => {
    mockDecoded = { width: 1200, height: 900 };

    const uri = await compressImage(ORIGINAL, CONFIG);

    // No resize was needed, yet the bytes are a new JPEG of the decoded pixels, never the original.
    expect(mockContexts.flatMap((context) => context.resize.mock.calls)).toEqual([]);
    const saved = await savedFrom();
    expect(saved.saveAsync).toHaveBeenCalledWith({ format: SaveFormat.JPEG, compress: 0.8 });
    // Only format and quality: no option exists to carry metadata over, and none is passed.
    expect(Object.keys(saved.saveAsync.mock.calls[0][0]).sort()).toEqual(["compress", "format"]);
    expect(uri).toBe("file:///cache/decoded.jpg");
    expect(uri).not.toBe(ORIGINAL);
  });

  it("releases every native image it made", async () => {
    mockDecoded = { width: 4032, height: 3024 };

    await compressImage(ORIGINAL, CONFIG);

    mockContexts.forEach((context) => expect(context.release).toHaveBeenCalled());
    const refs = await Promise.all(
      mockContexts.map((context) => context.renderAsync.mock.results[0]?.value as Promise<MockRef>),
    );
    refs.filter(Boolean).forEach((ref) => expect(ref.release).toHaveBeenCalled());
  });
});

describe("prepareMedia", () => {
  it("an image of any type comes out as image/jpeg", async () => {
    mockDecoded = { width: 800, height: 600 };

    await expect(
      prepareMedia({ uri: ORIGINAL, kind: "image", mimeType: "image/heic" }, CONFIG),
    ).resolves.toEqual({
      uri: "file:///cache/decoded.jpg",
      contentType: "image/jpeg",
      kind: "image",
    });
  });

  it("a video goes as it is, typed from the picker or its extension", async () => {
    const video = { uri: "file:///picker/clip.mov", kind: "video" as const, fileSize: 1024 };

    await expect(prepareMedia({ ...video, mimeType: "video/mp4" }, CONFIG)).resolves.toEqual({
      uri: video.uri,
      contentType: "video/mp4",
      kind: "video",
      sizeBytes: 1024, // passed on, so the upload streams the file instead of reading it
    });
    await expect(prepareMedia(video, CONFIG)).resolves.toMatchObject({
      contentType: "video/quicktime",
    });
    expect(ImageManipulator.manipulate).not.toHaveBeenCalled();
  });

  it("a video over the limit is refused before any upload", async () => {
    const failure = await prepareMedia(
      {
        uri: "file:///picker/long.mp4",
        kind: "video",
        mimeType: "video/mp4",
        fileSize: CONFIG.videoMaxBytes + 1,
      },
      CONFIG,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(MediaTooLargeError);
    expect(failure).toMatchObject({ maxBytes: CONFIG.videoMaxBytes });
  });

  it("a video at the limit, or of unknown size, is left to the API's check", async () => {
    const video = { uri: "file:///picker/clip.mp4", kind: "video" as const, mimeType: "video/mp4" };

    await expect(
      prepareMedia({ ...video, fileSize: CONFIG.videoMaxBytes }, CONFIG),
    ).resolves.toBeTruthy();
    await expect(prepareMedia(video, CONFIG)).resolves.toBeTruthy();
  });

  it("a video in another format is refused", async () => {
    await expect(
      prepareMedia(
        { uri: "file:///picker/clip.3gp", kind: "video", mimeType: "video/3gpp" },
        CONFIG,
      ),
    ).rejects.toBeInstanceOf(UnsupportedMediaError);
    await expect(
      prepareMedia({ uri: "file:///picker/clip.avi", kind: "video" }, CONFIG),
    ).rejects.toBeInstanceOf(UnsupportedMediaError);
  });
});
