import * as ImagePicker from "expo-image-picker";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  isCurrentGeneration,
  onSignOut,
  sessionGeneration,
  uploadMedia,
  UploadRejectedError,
  type UploadPurpose,
} from "@/api";

import { deleteAppFile } from "./appFiles";
import { prepareMedia, type MediaKind, type PickedMedia, type PreparedMedia } from "./compress";
import { mediaConfig } from "./config";
import { MediaSizeUnknownError, MediaTooLargeError, UnsupportedMediaError } from "./errors";

export type MediaSource = "camera" | "library";
export type MediaItemStatus = "compressing" | "uploading" | "done" | "failed";

/**
 * Why an item failed. `failed` (the connection, the storage, or the device could not prepare the
 * file) can be retried; the others would fail the same way again.
 */
export type MediaFailure = "failed" | "rejected" | "tooLarge" | "sizeUnknown" | "unsupported";

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
  /**
   * A full list still takes a pick: what is picked takes the place of what is held (a profile
   * photo, chosen again). The items held stay until the picker hands something over, so closing
   * it without a choice changes nothing.
   */
  replace?: boolean;
  /**
   * Sensitive photos (a pro's documents): the files the app makes for an item, the picker's copy
   * and the compressed JPEG, are deleted as soon as nothing needs them. The compressed one goes
   * once the storage has it; both go when the item is set aside (removed, replaced), when the
   * screen leaves and at the account boundary, and a compression that ends after that deletes its
   * result. A failed upload keeps its file for a retry until the item goes. Only files recorded
   * here as the app's own are deleted, and only inside the app's cache: never a library original.
   */
  discardFiles?: boolean;
};

// The API takes videos for request media only; every other purpose is photos (PURPOSES table).
const VIDEO_PURPOSES: ReadonlySet<UploadPurpose> = new Set<UploadPurpose>(["request_media"]);
const RETRYABLE: ReadonlySet<MediaFailure> = new Set<MediaFailure>(["failed"]);

/** What the hook keeps per item beyond what the screen shows. */
type Entry = {
  picked: PickedMedia;
  prepared?: PreparedMedia;
  controller?: AbortController;
  /** The session generation the item was picked (or last retried) in: it works for that one only. */
  generation: number;
  /** The files the app made for the item and still has on disk (`discardFiles` only). */
  owned: Set<string>;
};

export const isRetryable = (failure: MediaFailure | null): boolean =>
  failure !== null && RETRYABLE.has(failure);

function describeFailure(error: unknown): MediaFailure {
  if (error instanceof MediaTooLargeError) return "tooLarge";
  if (error instanceof MediaSizeUnknownError) return "sizeUnknown";
  if (error instanceof UnsupportedMediaError) return "unsupported";
  if (error instanceof UploadRejectedError) return "rejected";
  return "failed";
}

/** Deletes the files the app made for `entry` (all of them, or the one `uri`). */
function deleteOwned(entry: Entry, uri?: string): void {
  for (const owned of entry.owned) {
    if (uri !== undefined && owned !== uri) continue;
    entry.owned.delete(owned);
    deleteAppFile(owned);
  }
}

/** The item is set aside: its work stops, and its files go. */
function drop(entry: Entry): void {
  entry.controller?.abort();
  deleteOwned(entry);
}

/** The compressed copy, once nothing needs it (a video goes as it was picked: nothing to delete). */
function deletePrepared(entry: Entry): void {
  if (entry.prepared && entry.prepared.uri !== entry.picked.uri) {
    deleteOwned(entry, entry.prepared.uri);
  }
}

function toPicked(asset: ImagePicker.ImagePickerAsset): PickedMedia {
  const isVideo =
    asset.type === "video" || (!asset.type && Boolean(asset.mimeType?.startsWith("video/")));
  // The picker's fileSize is left out: it can be missing or stale, so prepareMedia measures the file.
  return { uri: asset.uri, kind: isVideo ? "video" : "image", mimeType: asset.mimeType };
}

/**
 * Picks photos (and, for request media, videos), prepares each one (`prepareMedia`) and uploads
 * it (`uploadMedia`), keeping a list of items with their status, progress and key. Files are
 * processed one at a time, in order, so a slow phone never decodes ten photos at once. Unmounting
 * cancels whatever is in flight. The list belongs to the signed-in account: a sign-out, or a
 * sign-in that brings another account, cancels and drops it.
 */
export function useMediaUpload({
  purpose,
  max = mediaConfig.requestMediaMax,
  replace = false,
  discardFiles = false,
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
      // Every item, running or still waiting its turn: nothing is prepared or uploaded after this.
      live.forEach(drop);
      live.clear();
    };
  }, []);

  // The account boundary: everything picked under the old account, running, waiting its turn or
  // done, is cancelled and dropped with its previews and keys, and a fresh queue starts, so
  // nothing of it is shown, counted, attached or uploaded for the next one.
  useEffect(
    () =>
      onSignOut(() => {
        entries.current.forEach(drop);
        entries.current.clear();
        queue.current = Promise.resolve();
        setItems([]);
        setPermissionDenied(null);
      }),
    [],
  );

  const update = useCallback((id: string, patch: Partial<MediaItem>) => {
    if (!mounted.current) return;
    setItems((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }, []);

  const process = useCallback(
    async (id: string) => {
      const entry = entries.current.get(id);
      const controller = entry?.controller;
      // Removed, or the screen left, while it waited its turn.
      if (!entry || !controller || controller.signal.aborted) return;
      // Every step belongs to the session the item was picked in. One that resumes under another
      // (a sign-in under way, or done) stops there: nothing is uploaded or recorded for it, and the
      // item waits for a retry (the same account) or the account boundary's clear (another one).
      const superseded = () => !isCurrentGeneration(entry.generation);
      const abandon = () => {
        controller.abort();
        update(id, { status: "failed", progress: 0, failure: "failed" });
      };
      try {
        if (!entry.prepared) {
          update(id, { status: "compressing", progress: 0, failure: null });
          const prepared = await prepareMedia(entry.picked);
          entry.prepared = prepared;
          if (discardFiles && prepared.uri !== entry.picked.uri) entry.owned.add(prepared.uri);
          // Set aside while it was compressed: its result goes too.
          if (controller.signal.aborted) return deleteOwned(entry);
        }
        if (superseded()) return abandon();
        update(id, { status: "uploading", progress: 0, failure: null });
        const { key } = await uploadMedia({
          purpose,
          file: entry.prepared,
          signal: controller.signal,
          onProgress: (progress) => {
            if (!superseded()) update(id, { progress });
          },
        });
        if (superseded()) return abandon();
        // The storage has it: the compressed copy is no longer needed (the preview stays).
        deletePrepared(entry);
        update(id, { status: "done", progress: 1, key });
      } catch (error) {
        if (controller.signal.aborted) return; // removed or unmounted: nothing to show
        if (superseded()) return abandon();
        const failure = describeFailure(error);
        // Kept for a retry; a failure no retry can mend needs it no more.
        if (!isRetryable(failure)) deletePrepared(entry);
        update(id, { status: "failed", failure });
      }
    },
    [discardFiles, purpose, update],
  );

  // The item's controller exists from the moment it is queued, so unmounting or removing it stops
  // it even before its turn.
  const enqueue = useCallback(
    (id: string) => {
      const entry = entries.current.get(id);
      if (!entry) return;
      if (!entry.controller || entry.controller.signal.aborted) {
        entry.controller = new AbortController();
      }
      queue.current = queue.current.then(() => process(id));
    },
    [process],
  );

  const remaining = Math.max(0, max - items.length);
  // How many files one pick may bring: all of the list when the pick replaces it.
  const room = replace ? max : remaining;

  const add = useCallback(
    async (source: MediaSource) => {
      if (pickingNow.current || room === 0) return;
      pickingNow.current = true;
      setPicking(true);
      // What the picker returns belongs to the session that opened it, and to no later one.
      const startedIn = sessionGeneration();
      try {
        let result: ImagePicker.ImagePickerResult;
        if (source === "camera") {
          const permission = await ImagePicker.requestCameraPermissionsAsync();
          if (!permission.granted) {
            if (mounted.current && isCurrentGeneration(startedIn)) setPermissionDenied("camera");
            return;
          }
          result = await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], exif: false });
        } else {
          // The system photo picker runs outside the app: it needs no library permission.
          result = await ImagePicker.launchImageLibraryAsync({
            mediaTypes: VIDEO_PURPOSES.has(purpose) ? ["images", "videos"] : ["images"],
            allowsMultipleSelection: true,
            selectionLimit: room,
            orderedSelection: true,
            exif: false,
          });
        }
        if (result.canceled || !mounted.current || !isCurrentGeneration(startedIn)) return;

        if (replace) {
          // The items held make way: their uploads stop, their keys are never attached, their
          // files go.
          entries.current.forEach(drop);
          entries.current.clear();
        }
        const added = result.assets.slice(0, room).map((asset) => {
          const id = `media-${(nextId.current += 1)}`;
          const picked = toPicked(asset);
          // The picker hands over its own copy of what was chosen: the app's file to delete.
          const owned = new Set(discardFiles ? [picked.uri] : []);
          entries.current.set(id, { picked, generation: startedIn, owned });
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
        setItems((current) => (replace ? added : [...current, ...added]));
        added.forEach((item) => enqueue(item.id));
      } finally {
        pickingNow.current = false;
        if (mounted.current) setPicking(false);
      }
    },
    [discardFiles, enqueue, purpose, replace, room],
  );

  const retry = useCallback(
    (id: string) => {
      const item = items.find((candidate) => candidate.id === id);
      const entry = entries.current.get(id);
      if (!entry || !item || item.status !== "failed" || !isRetryable(item.failure)) return;
      // The list survives only the same account signing in again (the account boundary clears it
      // for any other), so the retry may run for the current session: keep the two together.
      entry.generation = sessionGeneration();
      // A file that was already prepared goes straight back to uploading.
      const prepared = Boolean(entry.prepared);
      update(id, { status: prepared ? "uploading" : "compressing", progress: 0, failure: null });
      enqueue(id);
    },
    [enqueue, items, update],
  );

  const remove = useCallback((id: string) => {
    const entry = entries.current.get(id);
    if (entry) drop(entry);
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
