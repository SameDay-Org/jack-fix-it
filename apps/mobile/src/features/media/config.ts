/** How the app prepares and counts media, read once at startup. The server stays the authority. */
export type MediaConfig = {
  /** Longest edge, in pixels, an image is resized down to before upload. */
  readonly imageMaxEdge: number;
  /** JPEG quality of the re-encoded image, from 0 (smallest) to 1 (best). */
  readonly imageQuality: number;
  /** Largest video accepted for upload, in bytes; mirrors the API's UPLOAD_MAX_VIDEO_BYTES. */
  readonly videoMaxBytes: number;
  /** Most files one request may carry; mirrors the API's REQUEST_MEDIA_MAX_ITEMS. */
  readonly requestMediaMax: number;
};

export const DEFAULT_IMAGE_MAX_EDGE = 2048;
export const DEFAULT_IMAGE_QUALITY = 0.8;
export const DEFAULT_VIDEO_MAX_BYTES = 100 * 1024 * 1024;
export const DEFAULT_REQUEST_MEDIA_MAX = 10;

type RawConfig = {
  imageMaxEdge: string | undefined;
  imageQuality: string | undefined;
  videoMaxBytes: string | undefined;
  requestMediaMax: string | undefined;
};

function positiveInteger(raw: string | undefined, fallback: number, name: string): number {
  const value = raw ? Number(raw) : fallback;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive whole number`);
  }
  return value;
}

/** Validates the raw environment values. Pure, so tests can cover every branch. */
export function readMediaConfig(raw: RawConfig): MediaConfig {
  const quality = raw.imageQuality ? Number(raw.imageQuality) : DEFAULT_IMAGE_QUALITY;
  if (!Number.isFinite(quality) || quality <= 0 || quality > 1) {
    throw new Error("EXPO_PUBLIC_IMAGE_QUALITY must be a number above 0 and at most 1");
  }
  return {
    imageMaxEdge: positiveInteger(
      raw.imageMaxEdge,
      DEFAULT_IMAGE_MAX_EDGE,
      "EXPO_PUBLIC_IMAGE_MAX_EDGE",
    ),
    imageQuality: quality,
    videoMaxBytes: positiveInteger(
      raw.videoMaxBytes,
      DEFAULT_VIDEO_MAX_BYTES,
      "EXPO_PUBLIC_UPLOAD_MAX_VIDEO_BYTES",
    ),
    requestMediaMax: positiveInteger(
      raw.requestMediaMax,
      DEFAULT_REQUEST_MEDIA_MAX,
      "EXPO_PUBLIC_REQUEST_MEDIA_MAX",
    ),
  };
}

// Literal `process.env.EXPO_PUBLIC_*` reads: Metro inlines them at build time.
export const mediaConfig: MediaConfig = readMediaConfig({
  imageMaxEdge: process.env.EXPO_PUBLIC_IMAGE_MAX_EDGE,
  imageQuality: process.env.EXPO_PUBLIC_IMAGE_QUALITY,
  videoMaxBytes: process.env.EXPO_PUBLIC_UPLOAD_MAX_VIDEO_BYTES,
  requestMediaMax: process.env.EXPO_PUBLIC_REQUEST_MEDIA_MAX,
});
