import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";

import { Button, Notice } from "@/components/ui";
import {
  MediaItemRow,
  MediaPermissionNotice,
  PhotoTiles,
  useMediaAdd,
  type RemotePhoto,
} from "@/features/media";

import { customerName } from "./format";
import type { JobPhotoKind, ProJob } from "./phase";
import { useJobPhotos, type TurnedAway } from "./useJobPhotos";

export type JobPhotoSectionProps = {
  job: ProJob;
  kind: JobPhotoKind;
  /** The time the tiles are drawn at (`useRefreshExpiredMedia`). */
  now: number;
  /** While the job takes photos of the kind: add, upload, save. Otherwise the saved ones only. */
  editable: boolean;
};

/**
 * The before or the after photos of a job. While the job takes them: what they are for, the
 * photos on the job as tiles, the ones picked here with their progress until Save attaches them,
 * how many fit, and Add. Otherwise the saved photos alone, as the job's record (nothing when
 * there are none).
 */
export function JobPhotoSection({ job, kind, now, editable }: JobPhotoSectionProps) {
  return editable ? (
    <EditablePhotos job={job} kind={kind} now={now} />
  ) : (
    <SavedPhotos photos={job.photos[kind]} kind={kind} now={now} />
  );
}

function SavedPhotos({
  photos,
  kind,
  now,
}: {
  photos: readonly RemotePhoto[];
  kind: JobPhotoKind;
  now: number;
}) {
  const { t } = useTranslation();
  if (photos.length === 0) return null;
  return (
    <View className="gap-3" testID={`pro-job-photos-${kind}`}>
      <Text accessibilityRole="header" className="text-headline text-navy-900">
        {t(`proJobs.photos.${kind}.title`)}
      </Text>
      <PhotoTiles
        photos={photos}
        now={now}
        label={(index, total) => t(`proJobs.photos.${kind}.tile`, { number: index + 1, total })}
        testID={`pro-job-photos-${kind}-tiles`}
      />
    </View>
  );
}

function EditablePhotos({ job, kind, now }: { job: ProJob; kind: JobPhotoKind; now: number }) {
  const { t } = useTranslation();
  const photos = useJobPhotos(job, kind);
  const { saved, upload, max, ready, uploading, saving, turnedAway, dismissTurnedAway } = photos;
  const { adding, add } = useMediaAdd(upload, {
    pathname: "/jobs/[id]/media-source",
    params: { id: job.id },
  });
  const count = saved.length + upload.items.length;
  const full = count >= max;
  const testID = `pro-job-photos-${kind}`;

  const addAgain = () => {
    dismissTurnedAway();
    void add();
  };

  return (
    <View className="gap-3" testID={testID}>
      <View className="gap-1">
        <Text accessibilityRole="header" className="text-headline text-navy-900">
          {t(`proJobs.photos.${kind}.title`)}
        </Text>
        <Text className="text-callout text-gray-500">
          {t(`proJobs.photos.${kind}.body`, {
            name: customerName(job) ?? t("proJobs.customerFallback"),
          })}
        </Text>
      </View>
      {saved.length > 0 ? (
        <PhotoTiles
          photos={saved}
          now={now}
          label={(index, total) => t(`proJobs.photos.${kind}.tile`, { number: index + 1, total })}
          testID={`${testID}-tiles`}
        />
      ) : null}
      {upload.items.map((item, index) => (
        <MediaItemRow
          key={item.id}
          item={item}
          index={index}
          name={t(`proJobs.photos.${kind}.item`, { number: saved.length + index + 1 })}
          onRetry={() => upload.retry(item.id)}
          onRemove={() => upload.remove(item.id)}
        />
      ))}
      <TurnedAwayNotice turnedAway={turnedAway} testID={`${testID}-turned-away`} />
      {upload.permissionDenied ? (
        <MediaPermissionNotice onDismiss={upload.dismissPermissionNotice} />
      ) : null}
      {count > 0 ? (
        <Text className="text-footnote text-gray-500" testID={`${testID}-count`}>
          {full ? t("proJobs.photos.full", { max }) : t("proJobs.photos.count", { count, max })}
        </Text>
      ) : null}
      {ready > 0 ? (
        <Text className="text-footnote text-gray-500" testID={`${testID}-final`}>
          {t("proJobs.photos.final")}
        </Text>
      ) : null}
      <View className="items-start gap-2">
        {ready > 0 ? (
          <Button
            label={t("proJobs.photos.save", { count: ready })}
            accessibilityHint={t("proJobs.photos.saveHint")}
            variant="secondary"
            disabled={uploading || adding}
            loading={saving}
            onPress={photos.save}
            testID={`${testID}-save`}
          />
        ) : null}
        <Button
          label={t(count > 0 ? "proJobs.photos.addMore" : `proJobs.photos.${kind}.add`)}
          variant={ready > 0 ? "ghost" : "secondary"}
          disabled={full || saving}
          loading={adding}
          onPress={addAgain}
          testID={`${testID}-add`}
        />
      </View>
    </View>
  );
}

/** Uploads the API turned away on the last save: each one is added again. */
function TurnedAwayNotice({ turnedAway, testID }: { turnedAway: TurnedAway; testID: string }) {
  const { t } = useTranslation();
  const { expired, refused } = turnedAway;
  if (expired + refused === 0) return null;
  return (
    <View className="gap-2" testID={testID}>
      {expired > 0 ? (
        <Notice
          tone="danger"
          title={t("proJobs.photos.expired.title", { count: expired })}
          body={t("proJobs.photos.again", { count: expired })}
          testID={`${testID}-expired`}
        />
      ) : null}
      {refused > 0 ? (
        <Notice
          tone="danger"
          title={t("proJobs.photos.refused.title", { count: refused })}
          body={t("proJobs.photos.again", { count: refused })}
          testID={`${testID}-refused`}
        />
      ) : null}
    </View>
  );
}
