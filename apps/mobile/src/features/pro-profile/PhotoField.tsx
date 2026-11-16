import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";

import { Avatar, Button, Card, ProgressRing } from "@/components/ui";
import { MediaPermissionNotice } from "@/features/media";

import type { ProProfile } from "./api";
import type { ProfilePhoto } from "./useProfilePhoto";

/** A URL this close to its expiry counts as expired: the photo would start loading as it runs out. */
const EXPIRY_MARGIN_MS = 30_000;
const PERCENT = 100;

/**
 * The profile's own photo. Every answer carries a new signed URL for the same picture: the one
 * the form opened with is kept while it still works, so the photo is not loaded twice.
 */
function useSavedPhotoUri(photo: ProProfile["photo"]): string | undefined {
  const [first] = useState(() =>
    photo && Date.parse(photo.expires_at) - EXPIRY_MARGIN_MS > Date.now() ? photo.url : undefined,
  );
  return first ?? photo?.url;
}

export type PhotoFieldProps = {
  photo: ProfilePhoto;
  /** The photo the profile already has. */
  saved: ProProfile["photo"];
  /** The pro's name: the picture's accessible label and, with no photo, its initials. */
  name: string;
  disabled: boolean;
};

/**
 * The photo's bubble: the picture (the new one once chosen, else the profile's), what is
 * happening to it, and the button that asks "Camera or library". A failed upload says so here
 * and offers a retry; the rest of the form is untouched.
 */
export function PhotoField({ photo, saved, name, disabled }: PhotoFieldProps) {
  const { t } = useTranslation();
  const savedUri = useSavedPhotoUri(saved);
  const uri = photo.previewUri ?? savedUri;
  const failed = photo.failure !== null;
  const status = photo.busy
    ? t("media.status.uploading", { percent: Math.round(photo.progress * PERCENT) })
    : failed
      ? t(photo.canRetry ? "media.status.failed" : "media.status.rejected")
      : photo.key
        ? t("proProfile.photo.ready")
        : t("proProfile.photo.support");

  return (
    <View className="gap-3">
      <Card testID="pro-profile-photo">
        <View className="flex-row items-center gap-4">
          <View>
            <Avatar name={name} imageUri={uri} size="lg" testID="pro-profile-photo-image" />
            {photo.busy ? (
              <View className="absolute inset-0 items-center justify-center rounded-pill bg-navy-900/40">
                <ProgressRing
                  progress={photo.progress}
                  accessibilityLabel={t("proProfile.photo.uploading")}
                />
              </View>
            ) : null}
          </View>
          <View className="flex-1 gap-1">
            <Text accessibilityRole="header" className="text-headline text-navy-900">
              {t("proProfile.photo.title")}
            </Text>
            <Text
              accessibilityLiveRegion="polite"
              className={failed ? "text-footnote text-danger" : "text-footnote text-gray-500"}
              testID="pro-profile-photo-status"
            >
              {status}
            </Text>
          </View>
        </View>
        <View className="mt-3 flex-row flex-wrap gap-2">
          <Button
            label={t(uri ? "proProfile.photo.change" : "proProfile.photo.add")}
            variant="secondary"
            loading={photo.choosing}
            disabled={disabled || photo.busy}
            onPress={photo.choose}
            testID="pro-profile-photo-choose"
          />
          {photo.canRetry ? (
            <Button
              label={t("proProfile.photo.retry")}
              variant="ghost"
              disabled={disabled}
              onPress={photo.retry}
              testID="pro-profile-photo-retry"
            />
          ) : null}
        </View>
      </Card>
      {photo.permissionDenied ? (
        <MediaPermissionNotice onDismiss={photo.dismissPermissionNotice} />
      ) : null}
    </View>
  );
}
