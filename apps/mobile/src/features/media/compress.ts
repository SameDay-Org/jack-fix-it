import { ImageManipulator, SaveFormat } from "expo-image-manipulator";

import { mediaConfig, type MediaConfig } from "./config";
import { MediaTooLargeError, UnsupportedMediaError } from "./errors";

export type MediaKind = "image" | "video";

/** A file the library or the camera returned. */
export type PickedMedia = {
  uri: string;
  kind: MediaKind;
  /** As the picker reported it; may be missing. */
  mimeType?: string;
  /** In bytes, as the picker reported it; may be missing. */
  fileSize?: number;
};

/** A file ready for `uploadMedia`: the type its bytes really are. */
export type PreparedMedia = { uri: string; contentType: string; kind: MediaKind };

const JPEG = "image/jpeg";
// The video types the API accepts for request media, and the extensions that stand for them.
const VIDEO_TYPES: ReadonlySet<string> = new Set(["video/mp4", "video/quicktime"]);
const VIDEO_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  mp4: "video/mp4",
  mov: "video/quicktime",
};

/**
 * Makes a picked file ready to upload. Images are always re-encoded as JPEG (`compressImage`).
 * Videos go as they are, after a type check and, when the picker knew the size, a size check;
 * when it did not, the API's own size check decides.
 */
export async function prepareMedia(
  picked: PickedMedia,
  config: MediaConfig = mediaConfig,
): Promise<PreparedMedia> {
  if (picked.kind === "image") {
    return { uri: await compressImage(picked.uri, config), contentType: JPEG, kind: "image" };
  }
  const contentType = videoContentType(picked);
  if (picked.fileSize !== undefined && picked.fileSize > config.videoMaxBytes) {
    throw new MediaTooLargeError(config.videoMaxBytes);
  }
  return { uri: picked.uri, contentType, kind: "video" };
}

function videoContentType({ mimeType, uri }: PickedMedia): string {
  if (mimeType && VIDEO_TYPES.has(mimeType)) return mimeType;
  const extension = uri.split("?")[0].split(".").pop()?.toLowerCase() ?? "";
  const byExtension = VIDEO_TYPE_BY_EXTENSION[extension];
  if (!mimeType && byExtension) return byExtension;
  throw new UnsupportedMediaError();
}

/**
 * Resizes an image so its long edge is at most `imageMaxEdge` (one side given, so the aspect
 * ratio holds) and saves it as a new JPEG at `imageQuality`. It is re-encoded even when no resize
 * is needed: the new file holds the decoded pixels only, so no EXIF from the original (GPS
 * included) reaches the upload, and HEIC, PNG or WebP come out as JPEG. Returns the new file's URI.
 */
export async function compressImage(
  uri: string,
  { imageMaxEdge, imageQuality }: Pick<MediaConfig, "imageMaxEdge" | "imageQuality">,
): Promise<string> {
  const loading = ImageManipulator.manipulate(uri);
  const decoded = await loading.renderAsync();
  const resizing = ImageManipulator.manipulate(decoded);
  try {
    let output = decoded;
    if (Math.max(decoded.width, decoded.height) > imageMaxEdge) {
      resizing.resize(
        decoded.width >= decoded.height ? { width: imageMaxEdge } : { height: imageMaxEdge },
      );
      output = await resizing.renderAsync();
    }
    try {
      const saved = await output.saveAsync({ format: SaveFormat.JPEG, compress: imageQuality });
      return saved.uri;
    } finally {
      if (output !== decoded) output.release();
    }
  } finally {
    resizing.release();
    decoded.release();
    loading.release();
  }
}
