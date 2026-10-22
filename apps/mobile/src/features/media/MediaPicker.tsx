import { router, type Href } from "expo-router";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";

import { Button, Card } from "@/components/ui";

import { MediaItemRow } from "./MediaItemRow";
import { MediaPermissionNotice } from "./MediaPermissionNotice";
import { chooseMediaSource } from "./mediaSource";
import type { MediaUpload } from "./useMediaUpload";

export type MediaPickerProps = {
  /** The list and its actions, from `useMediaUpload` in the screen that owns the files. */
  upload: MediaUpload;
  /** The route that renders `MediaSourceSheet` in this screen's stack. */
  sourceSheet: Href;
  testID?: string;
};

/**
 * Photos (and videos, for request media) attached to something: an empty state that says what to
 * add, one row per file with its progress and actions, how many fit, and the Add button, which
 * asks "Camera or library" in a sheet first. A refused camera shows the settings notice above.
 */
export function MediaPicker({ upload, sourceSheet, testID }: MediaPickerProps) {
  const { t } = useTranslation();
  const { items, max, remaining } = upload;
  const full = remaining === 0;

  const add = async () => {
    const source = await chooseMediaSource(() => router.push(sourceSheet));
    if (source) await upload.add(source);
  };

  return (
    <View className="gap-3" testID={testID}>
      {upload.permissionDenied ? (
        <MediaPermissionNotice onDismiss={upload.dismissPermissionNotice} />
      ) : null}
      {items.length === 0 ? (
        <Card testID="media-empty">
          <View className="gap-1">
            <Text className="text-headline text-navy-900">{t("media.emptyTitle")}</Text>
            <Text className="text-callout text-gray-500">
              {t(upload.acceptsVideo ? "media.emptyBodyMedia" : "media.emptyBodyPhotos", { max })}
            </Text>
          </View>
        </Card>
      ) : (
        items.map((item, index) => (
          <MediaItemRow
            key={item.id}
            item={item}
            index={index}
            onRetry={() => upload.retry(item.id)}
            onRemove={() => upload.remove(item.id)}
          />
        ))
      )}
      {items.length > 0 ? (
        <Text className="text-footnote text-gray-500" testID="media-count">
          {full ? t("media.limitReached") : t("media.count", { count: items.length, max })}
        </Text>
      ) : null}
      <Button
        label={t(items.length === 0 ? "media.add" : "media.addMore")}
        variant={items.length === 0 ? "primary" : "secondary"}
        disabled={full}
        loading={upload.picking}
        onPress={() => void add()}
        testID="media-add"
      />
    </View>
  );
}
