import {
  DEFAULT_IMAGE_MAX_EDGE,
  DEFAULT_IMAGE_QUALITY,
  DEFAULT_REQUEST_MEDIA_MAX,
  DEFAULT_VIDEO_MAX_BYTES,
  readMediaConfig,
} from "../config";

const UNSET = {
  imageMaxEdge: undefined,
  imageQuality: undefined,
  videoMaxBytes: undefined,
  requestMediaMax: undefined,
};

describe("readMediaConfig", () => {
  it("defaults every value when nothing is set", () => {
    expect(readMediaConfig(UNSET)).toEqual({
      imageMaxEdge: DEFAULT_IMAGE_MAX_EDGE,
      imageQuality: DEFAULT_IMAGE_QUALITY,
      videoMaxBytes: DEFAULT_VIDEO_MAX_BYTES,
      requestMediaMax: DEFAULT_REQUEST_MEDIA_MAX,
    });
  });

  it("reads each value from the environment", () => {
    expect(
      readMediaConfig({
        imageMaxEdge: "1600",
        imageQuality: "0.7",
        videoMaxBytes: "52428800",
        requestMediaMax: "6",
      }),
    ).toEqual({
      imageMaxEdge: 1600,
      imageQuality: 0.7,
      videoMaxBytes: 52_428_800,
      requestMediaMax: 6,
    });
  });

  it.each([
    [{ imageMaxEdge: "wide" }, /EXPO_PUBLIC_IMAGE_MAX_EDGE/],
    [{ imageQuality: "0" }, /EXPO_PUBLIC_IMAGE_QUALITY/],
    [{ imageQuality: "1.5" }, /EXPO_PUBLIC_IMAGE_QUALITY/],
    [{ videoMaxBytes: "-1" }, /EXPO_PUBLIC_UPLOAD_MAX_VIDEO_BYTES/],
    [{ requestMediaMax: "2.5" }, /EXPO_PUBLIC_REQUEST_MEDIA_MAX/],
  ])("refuses %j", (raw, message) => {
    expect(() => readMediaConfig({ ...UNSET, ...raw })).toThrow(message);
  });
});
