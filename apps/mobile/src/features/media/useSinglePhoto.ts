import type { Href } from "expo-router";
import type { TFunction } from "i18next";

import type { UploadPurpose } from "@/api";

import { useMediaAdd } from "./useMediaAdd";
import { useMediaUpload, type MediaFailure } from "./useMediaUpload";

export type SinglePhoto = {
  /** The new photo as picked, for the preview; none until one is chosen. */
  previewUri: string | undefined;
  /** The new photo is being prepared or uploaded. */
  busy: boolean;
  /** The share of the photo the storage has taken, 0 to 1, while `busy`. */
  progress: number;
  /** The upload's key once the storage has the photo: what the screen attaches. */
  key: string | null;
  /** Why the new photo did not upload; the rest of the screen is untouched. */
  failure: MediaFailure | null;
  /** The upload can be tried again as it is (a connection failure). */
  canRetry: boolean;
  retry: () => void;
  /** The camera or the picker is opening. */
  choosing: boolean;
  /** Asks "Camera or library", then prepares and uploads the photo chosen there. */
  choose: () => void;
  /** Sets the new photo aside: what was there before it stays. */
  discard: () => void;
  /** The camera was refused; the screen explains and offers the device settings. */
  permissionDenied: boolean;
  dismissPermissionNotice: () => void;
};

export type SinglePhotoOptions = {
  purpose: UploadPurpose;
  /** The route that renders `MediaSourceSheet` in the screen's stack. */
  sourceSheet: Href;
  /** Delete the app's copies of the photo as soon as nothing needs them (`useMediaUpload`). */
  discardFiles?: boolean;
};

/**
 * One photo for something that holds a single picture (a profile photo, a document): from the
 * camera or the library, compressed and uploaded as the request media are. Choosing again
 * replaces it, and closing the picker without a choice keeps the one held. Nothing here attaches
 * the photo: the screen sends the key.
 */
export function useSinglePhoto({
  purpose,
  sourceSheet,
  discardFiles = false,
}: SinglePhotoOptions): SinglePhoto {
  // One photo, and choosing again replaces it once the picker hands the new one over.
  const upload = useMediaUpload({ purpose, max: 1, replace: true, discardFiles });
  const { adding, add } = useMediaAdd(upload, sourceSheet);
  const item = upload.items.at(0);
  const discard = () => {
    if (item) upload.remove(item.id);
  };

  return {
    previewUri: item?.previewUri,
    busy: item?.status === "compressing" || item?.status === "uploading",
    progress: item?.progress ?? 0,
    key: item?.status === "done" ? item.key : null,
    failure: item?.status === "failed" ? item.failure : null,
    canRetry: item?.status === "failed" && item.failure === "failed",
    retry: () => {
      if (item) upload.retry(item.id);
    },
    choosing: adding,
    choose: () => void add(),
    discard,
    permissionDenied: upload.permissionDenied !== null,
    dismissPermissionNotice: upload.dismissPermissionNotice,
  };
}

const PERCENT = 100;

/**
 * What is happening to the new photo, in the app's language: how far the upload is, or why it
 * failed. `null` while there is nothing to say (no new photo, or one that is ready).
 */
export function singlePhotoStatus(t: TFunction, photo: SinglePhoto): string | null {
  if (photo.busy) {
    return t("media.status.uploading", { percent: Math.round(photo.progress * PERCENT) });
  }
  if (photo.failure === null) return null;
  return t(photo.canRetry ? "media.status.failed" : "media.status.rejected");
}
