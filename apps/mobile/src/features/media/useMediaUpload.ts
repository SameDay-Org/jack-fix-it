import * as ImagePicker from "expo-image-picker";
import { useCallback, useEffect, useRef, useState } from "react";

import { uploadMedia, UploadRejectedError, type UploadPurpose } from "@/api";

import { prepareMedia, type MediaKind, type PickedMedia, type PreparedMedia } from "./compress";
import { mediaConfig } from "./config";
import { MediaTooLargeError, UnsupportedMediaError } from "./errors";

export type MediaSource = "camera" | "library";
export type MediaItemStatus = "compressing" | "uploading" | "done" | "failed";

/**
 * Why an item failed. `failed` (the connection, the storage, or the device could not prepare the
 * file) can be retried; the others would fail the same way again.
 */
export type MediaFailure = "failed" | "rejected" | "tooLarge" | "unsupported";

export type MediaItem = {
  id: string;
  kind: MediaKind;
  /** The picked file, for the thumbnail; never logged. */
  previewUri: string;
  status: MediaItemStatus;
  /** The share of the file the storage has taken, 0 to 1; meaningful while `uploading`. */
  progress: number;
  /** The storage key once `done`: what the feature attaches. */
  key: string | null;
  failure: MediaFailure | null;
};

export type MediaUpload = {
  items: MediaItem[];
  /** Most items the list may hold. */
  max: number;
  /** Whether the library offers videos too (request media only). */
  acceptsVideo: boolean;
  /** Keys of the finished uploads, in the order the files were added. */
  keys: string[];
  /** How many more files fit under the limit; failed items still take their place until removed. */
  remaining: number;
  /** The system picker or camera is open. */
  picking: boolean;
  /** The camera was refused; the screen explains and offers the device settings. */
  permissionDenied: MediaSource | null;
  dismissPermissionNotice: () => void;
  /** Opens the camera or the library, then prepares and uploads each file, one at a time. */
  add: (source: MediaSource) => Promise<void>;
  /** Starts a failed item over, from the step that failed; only for a retryable failure. */
  retry: (id: string) => void;
  /** Drops the item from this list (an upload in flight is cancelled); nothing is deleted on the server. */
  remove: (id: string) => void;
};

export type MediaUploadOptions = {
  purpose: UploadPurpose;
  /** Most items the list may hold; defaults to `EXPO_PUBLIC_REQUEST_MEDIA_MAX`. */
  max?: number;
};

// The API takes videos for request media only; every other purpose is photos (PURPOSES table).
const VIDEO_PURPOSES: ReadonlySet<UploadPurpose> = new Set<UploadPurpose>(["request_media"]);
const RETRYABLE: ReadonlySet<MediaFailure> = new Set<MediaFailure>(["failed"]);

/** What the hook keeps per item beyond what the screen shows. */
type Entry = { picked: PickedMedia; prepared?: PreparedMedia; controller?: AbortController };

export const isRetryable = (failure: MediaFailure | null): boolean =>
  failure !== null && RETRYABLE.has(failure);

function describeFailure(error: unknown): MediaFailure {
  if (error instanceof MediaTooLargeError) return "tooLarge";
  if (error instanceof UnsupportedMediaError) return "unsupported";
  if (error instanceof UploadRejectedError) return "rejected";
  return "failed";
}

function toPicked(asset: ImagePicker.ImagePickerAsset): PickedMedia {
  const isVideo =
    asset.type === "video" || (!asset.type && Boolean(asset.mimeType?.startsWith("video/")));
  return {
    uri: asset.uri,
    kind: isVideo ? "video" : "image",
    mimeType: asset.mimeType,
    fileSize: asset.fileSize,
  };
}

/**
 * Picks photos (and, for request media, videos), prepares each one (`prepareMedia`) and uploads
 * it (`uploadMedia`), keeping a list of items with their status, progress and key. Files are
 * processed one at a time, in order, so a slow phone never decodes ten photos at once. Unmounting
 * cancels whatever is in flight.
 */
export function useMediaUpload({
  purpose,
  max = mediaConfig.requestMediaMax,
}: MediaUploadOptions): MediaUpload {
  const [items, setItems] = useState<MediaItem[]>([]);
  const [picking, setPicking] = useState(false);
  const [permissionDenied, setPermissionDenied] = useState<MediaSource | null>(null);
  const entries = useRef(new Map<string, Entry>());
  const queue = useRef<Promise<void>>(Promise.resolve());
  const nextId = useRef(0);
  const mounted = useRef(true);
  const pickingNow = useRef(false);

  useEffect(() => {
    mounted.current = true;
    const live = entries.current;
    return () => {
      mounted.current = false;
      live.forEach((entry) => entry.controller?.abort());
    };
  }, []);

  const update = useCallback((id: string, patch: Partial<MediaItem>) => {
    if (!mounted.current) return;
    setItems((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }, []);

  const process = useCallback(
    async (id: string) => {
      const entry = entries.current.get(id);
      if (!entry) return; // removed while it waited its turn
      const controller = new AbortController();
      entry.controller = controller;
      try {
        if (!entry.prepared) {
          update(id, { status: "compressing", progress: 0, failure: null });
          entry.prepared = await prepareMedia(entry.picked);
        }
        if (controller.signal.aborted) return;
        update(id, { status: "uploading", progress: 0, failure: null });
        const { key } = await uploadMedia({
          purpose,
          file: entry.prepared,
          signal: controller.signal,
          onProgress: (progress) => update(id, { progress }),
        });
        update(id, { status: "done", progress: 1, key });
      } catch (error) {
        if (controller.signal.aborted) return; // removed or unmounted: nothing to show
        update(id, { status: "failed", failure: describeFailure(error) });
      }
    },
    [purpose, update],
  );

  const enqueue = useCallback(
    (id: string) => {
      queue.current = queue.current.then(() => process(id));
    },
    [process],
  );

  const remaining = Math.max(0, max - items.length);

  const add = useCallback(
    async (source: MediaSource) => {
      if (pickingNow.current || remaining === 0) return;
      pickingNow.current = true;
      setPicking(true);
      try {
        let result: ImagePicker.ImagePickerResult;
        if (source === "camera") {
          const permission = await ImagePicker.requestCameraPermissionsAsync();
          if (!permission.granted) {
            if (mounted.current) setPermissionDenied("camera");
            return;
          }
          result = await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], exif: false });
        } else {
          // The system photo picker runs outside the app: it needs no library permission.
          result = await ImagePicker.launchImageLibraryAsync({
            mediaTypes: VIDEO_PURPOSES.has(purpose) ? ["images", "videos"] : ["images"],
            allowsMultipleSelection: true,
            selectionLimit: remaining,
            orderedSelection: true,
            exif: false,
          });
        }
        if (result.canceled || !mounted.current) return;

        const added = result.assets.slice(0, remaining).map((asset) => {
          const id = `media-${(nextId.current += 1)}`;
          const picked = toPicked(asset);
          entries.current.set(id, { picked });
          const item: MediaItem = {
            id,
            kind: picked.kind,
            previewUri: picked.uri,
            status: "compressing",
            progress: 0,
            key: null,
            failure: null,
          };
          return item;
        });
        setItems((current) => [...current, ...added]);
        added.forEach((item) => enqueue(item.id));
      } finally {
        pickingNow.current = false;
        if (mounted.current) setPicking(false);
      }
    },
    [enqueue, purpose, remaining],
  );

  const retry = useCallback(
    (id: string) => {
      const item = items.find((candidate) => candidate.id === id);
      if (!item || item.status !== "failed" || !isRetryable(item.failure)) return;
      // A file that was already prepared goes straight back to uploading.
      const prepared = Boolean(entries.current.get(id)?.prepared);
      update(id, { status: prepared ? "uploading" : "compressing", progress: 0, failure: null });
      enqueue(id);
    },
    [enqueue, items, update],
  );

  const remove = useCallback((id: string) => {
    entries.current.get(id)?.controller?.abort();
    entries.current.delete(id);
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  const dismissPermissionNotice = useCallback(() => setPermissionDenied(null), []);

  return {
    items,
    max,
    acceptsVideo: VIDEO_PURPOSES.has(purpose),
    keys: items.flatMap((item) => (item.status === "done" && item.key ? [item.key] : [])),
    remaining,
    picking,
    permissionDenied,
    dismissPermissionNotice,
    add,
    retry,
    remove,
  };
}
