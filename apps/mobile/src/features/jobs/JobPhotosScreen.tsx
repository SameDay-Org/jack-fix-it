import { useQuery } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ScrollView,
  Text,
  useWindowDimensions,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { isCurrentGeneration, useSessionGeneration } from "@/api";
import { Button, Screen } from "@/components/ui";
import { useRefreshExpiredMedia } from "@/features/opportunities/useOpportunity";

import { PhotoImage } from "./AfterPhotos";
import { customerJobQueryOptions } from "./api";

// The close button and the count sit this far below the status bar, inset from the edges.
const BAR_TOP = 8;
const NO_PHOTOS: readonly never[] = [];

/** The page a link asks for, kept inside the photos there are. */
function startPage(raw: string | undefined, total: number): number {
  const page = raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : 0;
  return Math.min(Math.max(0, page), Math.max(0, total - 1));
}

/**
 * The job's after photos full screen (`/requests/[id]/photos?index=…`, over the job): one photo
 * per page, whole on the navy page, swiped through, with a round close and "2 of 3" at the top.
 * It reads the job the screen under it already holds (never fetched here; a link without it on
 * screen closes again) and asks for it again when a photo's signed URL expires. Each page is an
 * image named for screen readers.
 */
export function JobPhotosScreen() {
  const { t } = useTranslation();
  const { id, index } = useLocalSearchParams<{ id: string; index?: string }>();
  const generation = useSessionGeneration();
  const { top } = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const {
    data: job,
    dataUpdatedAt,
    refetch,
  } = useQuery({
    ...customerJobQueryOptions(id, generation),
    enabled: false,
  });
  const photos = job?.photos.after ?? NO_PHOTOS;
  const [start] = useState(() => startPage(index, photos.length));
  const [page, setPage] = useState(start);
  // `refetch` runs even on a disabled query: only for the session that holds the job.
  const refresh = useCallback(
    () => (isCurrentGeneration(generation) ? refetch() : Promise.resolve()),
    [generation, refetch],
  );
  const now = useRefreshExpiredMedia(photos, dataUpdatedAt, refresh);

  const empty = photos.length === 0;
  useEffect(() => {
    if (empty) router.back();
  }, [empty]);
  if (empty) return null;

  const onScrollEnd = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const next = Math.round(event.nativeEvent.contentOffset.x / width);
    setPage(Math.min(photos.length - 1, Math.max(0, next)));
  };

  return (
    <Screen bar="hero" edges={["bottom"]} testID="job-photos-screen">
      <ScrollView
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        contentOffset={{ x: start * width, y: 0 }}
        onMomentumScrollEnd={onScrollEnd}
        testID="job-photos-pages"
      >
        {photos.map((photo, number) => (
          <View
            key={photo.id}
            accessible
            accessibilityRole="image"
            accessibilityLabel={t("jobs.afterPhotos.photo", {
              number: number + 1,
              total: photos.length,
            })}
            className="flex-1"
            style={{ width }}
            testID={`job-photos-page-${number}`}
          >
            <PhotoImage
              photo={photo}
              now={now}
              fit="contain"
              tone="dark"
              testID={`job-photos-page-${number}`}
            />
          </View>
        ))}
      </ScrollView>
      <View
        className="absolute left-4 right-4 flex-row items-center justify-between"
        style={{ top: top + BAR_TOP }}
      >
        <Button
          glyph="close"
          variant="hero"
          label={t("jobs.afterPhotos.close")}
          onPress={() => router.back()}
          testID="job-photos-close"
        />
        {photos.length > 1 ? (
          <Text
            accessibilityElementsHidden
            importantForAccessibility="no"
            className="text-callout font-semibold text-white"
            testID="job-photos-count"
          >
            {t("jobs.afterPhotos.page", { number: page + 1, total: photos.length })}
          </Text>
        ) : null}
      </View>
    </Screen>
  );
}
