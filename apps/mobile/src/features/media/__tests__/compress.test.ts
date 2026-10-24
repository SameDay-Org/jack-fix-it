import { ImageManipulator, SaveFormat } from "expo-image-manipulator";

import { localFileSize } from "@/api";

import { compressImage, prepareMedia } from "../compress";
import type { MediaConfig } from "../config";
import { MediaSizeUnknownError, MediaTooLargeError, UnsupportedMediaError } from "../errors";

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
// The size the file's metadata reports, by URI (`localFileSize`); a missing URI is unknown.
const mockSizes = new Map<string, number>();

jest.mock("@/api", () => ({
  localFileSize: jest.fn((uri: string) => mockSizes.get(uri) ?? null),
}));
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
  mockSizes.clear();
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

  it("a file that cannot be decoded still releases its loading context", async () => {
    mockDecoded = { width: 4032, height: 3024 };
    jest.mocked(ImageManipulator.manipulate).mockImplementationOnce((source) => {
      const context = {
        source,
        resize: jest.fn(),
        renderAsync: jest.fn(async () => {
          throw new Error("decode failed");
        }),
        release: jest.fn(),
      };
      mockContexts.push(context);
      return context as unknown as ReturnType<typeof ImageManipulator.manipulate>;
    });

    await expect(compressImage(ORIGINAL, CONFIG)).rejects.toThrow("decode failed");

    expect(mockContexts).toHaveLength(1);
    expect(mockContexts[0].release).toHaveBeenCalled();
  });

  it("a second context that cannot be made still releases the decoded image and the first", async () => {
    mockDecoded = { width: 4032, height: 3024 };
    const manipulate = jest.mocked(ImageManipulator.manipulate);
    const real = manipulate.getMockImplementation();
    manipulate.mockImplementation((source) => {
      if (typeof source !== "string") throw new Error("out of memory");
      return real!(source);
    });
    try {
      await expect(compressImage(ORIGINAL, CONFIG)).rejects.toThrow("out of memory");

      const [loading] = mockContexts;
      const decoded = (await loading.renderAsync.mock.results[0].value) as MockRef;
      expect(loading.release).toHaveBeenCalled();
      expect(decoded.release).toHaveBeenCalled();
    } finally {
      manipulate.mockImplementation(real);
    }
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
    const video = { uri: "file:///picker/clip.mov", kind: "video" as const };
    mockSizes.set(video.uri, 1024);

    await expect(prepareMedia({ ...video, mimeType: "video/mp4" }, CONFIG)).resolves.toEqual({
      uri: video.uri,
      contentType: "video/mp4",
      kind: "video",
    });
    await expect(prepareMedia(video, CONFIG)).resolves.toMatchObject({
      contentType: "video/quicktime",
    });
    expect(ImageManipulator.manipulate).not.toHaveBeenCalled();
  });

  describe("the video size comes from the file's metadata", () => {
    const video = { uri: "file:///picker/clip.mp4", kind: "video" as const, mimeType: "video/mp4" };
    let fetchSpy: jest.SpyInstance;

    beforeEach(() => {
      fetchSpy = jest.spyOn(globalThis, "fetch").mockImplementation(async () => {
        throw new Error("prepareMedia must not call the network");
      });
    });
    afterEach(() => {
      // Neither the accepted nor the refused size was checked by asking the API.
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    it("exactly the limit is accepted", async () => {
      mockSizes.set(video.uri, CONFIG.videoMaxBytes);

      await expect(prepareMedia(video, CONFIG)).resolves.toMatchObject({ kind: "video" });
      expect(localFileSize).toHaveBeenCalledWith(video.uri);
    });

    it("one byte over the limit is too large, before any upload", async () => {
      mockSizes.set(video.uri, CONFIG.videoMaxBytes + 1);

      const failure = await prepareMedia(video, CONFIG).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(MediaTooLargeError);
      expect(failure).toMatchObject({ maxBytes: CONFIG.videoMaxBytes });
    });

    it("a video whose size cannot be found is refused here", async () => {
      await expect(prepareMedia(video, CONFIG)).rejects.toBeInstanceOf(MediaSizeUnknownError);
    });
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
