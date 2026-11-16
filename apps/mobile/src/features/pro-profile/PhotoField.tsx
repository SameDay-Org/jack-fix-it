import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";

import { Avatar, Button, Card, ProgressRing } from "@/components/ui";
import { MediaPermissionNotice, singlePhotoStatus, useStableImageUri } from "@/features/media";

import type { ProProfile } from "./api";
import type { ProfilePhoto } from "./useProfilePhoto";

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
  // Every answer carries a new signed URL for the same photo: the first is kept while it works.
  const savedUri = useStableImageUri(saved);
  const uri = photo.previewUri ?? savedUri;
  const failed = photo.failure !== null;
  const status =
    singlePhotoStatus(t, photo) ??
    t(photo.key ? "proProfile.photo.ready" : "proProfile.photo.support");

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
