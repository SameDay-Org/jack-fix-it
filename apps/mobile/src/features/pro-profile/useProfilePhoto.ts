import { useSinglePhoto, type SinglePhoto } from "@/features/media";

/** The "Camera or library" sheet of the profile's stack. */
const SOURCE_SHEET = "/pro/profile/media-source";

export type ProfilePhoto = SinglePhoto;

/** The profile's new photo (`profile_photo`). Nothing here touches the profile: Save sends the key. */
export const useProfilePhoto = (): ProfilePhoto =>
  useSinglePhoto({ purpose: "profile_photo", sourceSheet: SOURCE_SHEET });
