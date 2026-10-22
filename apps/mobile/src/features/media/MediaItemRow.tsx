import type { TFunction } from "i18next";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { AccessibilityInfo, Image, Text, View } from "react-native";

import { Button, Card, ProgressRing } from "@/components/ui";
import { continuousCorners } from "@/theme";

import { mediaConfig } from "./config";
import { isRetryable, type MediaItem } from "./useMediaUpload";

export type MediaItemRowProps = {
  item: MediaItem;
  /** Its place in the list, from 0; names it "Photo 1", "Video 2". */
  index: number;
  onRetry: () => void;
  onRemove: () => void;
};

const BYTES_PER_MB = 1024 * 1024;

function statusText(t: TFunction, item: MediaItem): string {
  switch (item.status) {
    case "compressing":
      return t("media.status.preparing");
    case "uploading":
      return t("media.status.uploading", { percent: Math.round(item.progress * 100) });
    case "done":
      return t("media.status.done");
    case "failed":
      if (item.failure === "tooLarge") {
        return t("media.status.tooLarge", {
          size: Math.round(mediaConfig.videoMaxBytes / BYTES_PER_MB),
        });
      }
      return t(`media.status.${item.failure ?? "failed"}`);
  }
}

/**
 * One picked file on a bubble card: its thumbnail (a progress ring over it while it is prepared
 * and uploaded, a success dot once it is in), its name and status, and its actions: Retry when
 * trying again can help, and Remove. The thumbnail and the ring keep a fixed size, so progress
 * never moves the layout. Assistive technology hears the outcome once (uploaded, or what went
 * wrong), not every percent.
 */
export function MediaItemRow({ item, index, onRetry, onRemove }: MediaItemRowProps) {
  const { t } = useTranslation();
  const name = t(item.kind === "video" ? "media.video" : "media.photo", { number: index + 1 });
  const working = item.status === "compressing" || item.status === "uploading";
  const failed = item.status === "failed";
  const status = statusText(t, item);

  // Announce an outcome when it happens, not on mount and not for every progress step.
  const announced = useRef(item.status);
  useEffect(() => {
    if (announced.current === item.status) return;
    announced.current = item.status;
    if (item.status === "done" || item.status === "failed") {
      AccessibilityInfo.announceForAccessibility(`${name}: ${status}`);
    }
  }, [item.status, name, status]);

  return (
    <Card testID={`media-item-${index}`}>
      <View className="flex-row gap-3">
        <View
          className="h-16 w-16 overflow-hidden rounded-md bg-navy-700"
          style={continuousCorners}
          // The status line below says everything the picture shows.
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          {item.kind === "image" ? (
            <Image
              source={{ uri: item.previewUri }}
              className="h-full w-full"
              resizeMode="cover"
              accessibilityIgnoresInvertColors
            />
          ) : (
            <View className="h-full w-full items-center justify-center">
              <Text className="text-caption text-white">{t("media.videoTile")}</Text>
            </View>
          )}
          {working ? (
            <View className="absolute inset-0 items-center justify-center bg-navy-900/40">
              <ProgressRing
                progress={item.status === "uploading" ? item.progress : 0}
                accessibilityLabel={name}
              />
            </View>
          ) : null}
          {failed ? <View className="absolute inset-0 bg-navy-900/40" /> : null}
          {item.status === "done" ? (
            <View className="absolute right-1 top-1 h-3 w-3 rounded-pill border-2 border-white bg-success" />
          ) : null}
        </View>
        <View className="flex-1 gap-1">
          <Text className="text-headline text-navy-900">{name}</Text>
          <Text
            className={failed ? "text-footnote text-danger" : "text-footnote text-gray-500"}
            testID={`media-item-${index}-status`}
          >
            {status}
          </Text>
          <View className="-ml-5 flex-row flex-wrap">
            {failed && isRetryable(item.failure) ? (
              <Button
                label={t("media.retry")}
                accessibilityLabel={t("media.itemRetry", { name })}
                variant="ghost"
                onPress={onRetry}
              />
            ) : null}
            <Button
              label={t("media.remove")}
              accessibilityLabel={t("media.itemRemove", { name })}
              variant="ghost"
              onPress={onRemove}
            />
          </View>
        </View>
      </View>
    </Card>
  );
}
