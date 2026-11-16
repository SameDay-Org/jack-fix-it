import { useMediaAdd, useMediaUpload, type MediaFailure } from "@/features/media";

/** The "Camera or library" sheet of the profile's stack. */
const SOURCE_SHEET = "/pro/profile/media-source";

export type ProfilePhoto = {
  /** The new photo as picked, for the preview; none until one is chosen. */
  previewUri: string | undefined;
  /** The new photo is being prepared or uploaded. */
  busy: boolean;
  /** The share of the photo the storage has taken, 0 to 1, while `busy`. */
  progress: number;
  /** The upload's key once the storage has the photo: what Save attaches. */
  key: string | null;
  /** Why the new photo did not upload; the rest of the form is untouched. */
  failure: MediaFailure | null;
  /** The upload can be tried again as it is (a connection failure). */
  canRetry: boolean;
  retry: () => void;
  /** The camera or the picker is opening. */
  choosing: boolean;
  /** Asks "Camera or library", then prepares and uploads the photo chosen there. */
  choose: () => void;
  /** Sets the new photo aside: the profile keeps the one it has. */
  discard: () => void;
  /** The camera was refused; the screen explains and offers the device settings. */
  permissionDenied: boolean;
  dismissPermissionNotice: () => void;
};

/**
 * The profile's new photo: one picture from the camera or the library, compressed and uploaded
 * (`profile_photo`) as the request media are. Choosing again replaces it, and closing the picker
 * without a choice keeps the one held. Nothing here touches the profile: Save sends the key.
 */
export function useProfilePhoto(): ProfilePhoto {
  // One photo, and choosing again replaces it once the picker hands the new one over.
  const upload = useMediaUpload({ purpose: "profile_photo", max: 1, replace: true });
  const { adding, add } = useMediaAdd(upload, SOURCE_SHEET);
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
