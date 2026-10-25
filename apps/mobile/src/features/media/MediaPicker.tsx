import { router, type Href } from "expo-router";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";

import { Button, Card, showToast } from "@/components/ui";

import { MediaItemRow } from "./MediaItemRow";
import { MediaPermissionNotice } from "./MediaPermissionNotice";
import { chooseMediaSource, closeMediaSourceSheet } from "./mediaSource";
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
 * asks "Camera or library" in a sheet first. A refused camera shows the settings notice right
 * above the button that asked for it.
 */
export function MediaPicker({ upload, sourceSheet, testID }: MediaPickerProps) {
  const { t } = useTranslation();
  const { items, max, remaining, acceptsVideo } = upload;
  const full = remaining === 0;
  // From the tap until the picker returns: a second tap opens nothing.
  const [adding, setAdding] = useState(false);
  const addingNow = useRef(false);

  const add = async () => {
    if (addingNow.current) return;
    addingNow.current = true;
    setAdding(true);
    try {
      const source = await chooseMediaSource(() => router.push(sourceSheet), { acceptsVideo });
      if (!source) return;
      try {
        await upload.add(source);
      } finally {
        closeMediaSourceSheet();
      }
    } catch {
      showToast({ message: t("media.pickFailed"), tone: "danger" });
    } finally {
      addingNow.current = false;
      setAdding(false);
    }
  };

  return (
    <View className="gap-3" testID={testID}>
      {items.length === 0 ? (
        <Card testID="media-empty">
          <View className="gap-1">
            <Text className="text-headline text-navy-900">
              {t(acceptsVideo ? "media.emptyTitleMedia" : "media.emptyTitle")}
            </Text>
            <Text className="text-callout text-gray-500">
              {t(acceptsVideo ? "media.emptyBodyMedia" : "media.emptyBodyPhotos", { max })}
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
      {upload.permissionDenied ? (
        <MediaPermissionNotice onDismiss={upload.dismissPermissionNotice} />
      ) : null}
      <Button
        label={t(
          items.length > 0 ? "media.addMore" : acceptsVideo ? "media.addMedia" : "media.add",
        )}
        variant={items.length === 0 ? "primary" : "secondary"}
        disabled={full}
        loading={adding || upload.picking}
        onPress={() => void add()}
        testID="media-add"
      />
    </View>
  );
}
