import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";

import { PhotoTiles, type RemotePhoto } from "@/features/media/PhotoTiles";
import { useRefreshExpiredMedia } from "@/features/opportunities/useOpportunity";

import type { CustomerJob } from "./phase";

export type JobPhotosProps = {
  photos: CustomerJob["photos"];
  /** When the job's last answer arrived, for the photos' signed URLs. */
  updatedAt: number;
  /** Asks for the job again: an expired URL on screen comes back fresh. */
  refetch: () => Promise<unknown>;
};

/**
 * The pro's before and after photos of the job (their privacy-safe copies), as two rows of tiles,
 * and how many more are still being prepared. Nothing until the pro adds one.
 */
export function JobPhotos({ photos, updatedAt, refetch }: JobPhotosProps) {
  const { t } = useTranslation();
  const { before, after, pending } = photos;
  const all = useMemo(() => [...before, ...after], [after, before]);
  const now = useRefreshExpiredMedia(all, updatedAt, refetch);
  if (all.length === 0 && pending === 0) return null;

  return (
    <View className="gap-3" testID="job-photos">
      <Text accessibilityRole="header" className="text-headline text-navy-900">
        {t("jobs.photos.title")}
      </Text>
      <PhotoRow kind="before" photos={before} now={now} />
      <PhotoRow kind="after" photos={after} now={now} />
      {pending > 0 ? (
        <Text className="text-footnote text-gray-500" testID="job-photos-pending">
          {t("jobs.photos.pending", { count: pending })}
        </Text>
      ) : null}
    </View>
  );
}

type PhotoRowProps = { kind: "before" | "after"; photos: readonly RemotePhoto[]; now: number };

function PhotoRow({ kind, photos, now }: PhotoRowProps) {
  const { t } = useTranslation();
  if (photos.length === 0) return null;
  return (
    <View className="gap-2">
      <Text className="text-footnote text-gray-500">{t(`jobs.photos.${kind}`)}</Text>
      <PhotoTiles
        photos={photos}
        now={now}
        label={(index, total) => t(`jobs.photos.${kind}Tile`, { number: index + 1, total })}
        testID={`job-photos-${kind}`}
      />
    </View>
  );
}
