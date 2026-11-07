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
import type { JobPhotos, TurnedAway } from "./useJobPhotos";

export type JobPhotoSectionProps = {
  job: ProJob;
  /** The kind's photos and their uploads, held by the screen (`useJobPhotos`). */
  photos: JobPhotos;
  /** The time the tiles are drawn at (`useRefreshExpiredMedia`). */
  now: number;
  /** While the job takes photos of the kind: add, upload, save. Otherwise the saved ones only. */
  editable: boolean;
  /** Job's done is under way: adding and saving wait for its answer. */
  held: boolean;
};

/**
 * The before or the after photos of a job. While the job takes them: what they are for, the
 * photos on the job as tiles, the ones picked here with their progress until Save attaches them,
 * how many fit, and Add. Otherwise the saved photos alone, as the job's record (nothing when
 * there are none).
 */
export function JobPhotoSection({ job, photos, now, editable, held }: JobPhotoSectionProps) {
  return editable ? (
    <EditablePhotos job={job} photos={photos} now={now} held={held} />
  ) : (
    <SavedPhotos photos={photos.saved} kind={photos.kind} now={now} />
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

type EditablePhotosProps = Omit<JobPhotoSectionProps, "editable">;

function EditablePhotos({ job, photos, now, held }: EditablePhotosProps) {
  const { t } = useTranslation();
  const { kind, saved, upload, max, ready, uploading, saving, turnedAway } = photos;
  const { adding, add } = useMediaAdd(upload, {
    pathname: "/jobs/[id]/media-source",
    params: { id: job.id },
  });
  const count = saved.length + upload.items.length;
  const full = count >= max;
  const testID = `pro-job-photos-${kind}`;

  const addAgain = () => {
    photos.dismissTurnedAway();
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
      <Text className="text-footnote text-gray-500" testID={`${testID}-count`}>
        {full
          ? t("proJobs.photos.full", { max })
          : count > 0
            ? t("proJobs.photos.count", { count, max })
            : t("proJobs.photos.upTo", { max })}
      </Text>
      {ready > 0 ? (
        <Text className="text-footnote text-gray-500" testID={`${testID}-final`}>
          {t("proJobs.photos.final")}
        </Text>
      ) : null}
      {/* Both sections are open while working: the visible words stay short (the header names
          the kind), and assistive technology hears which photos each button is for. */}
      <View className="items-start gap-2">
        {ready > 0 ? (
          <Button
            label={t("proJobs.photos.save", { count: ready })}
            accessibilityLabel={t(`proJobs.photos.${kind}.saveLabel`, { count: ready })}
            accessibilityHint={t("proJobs.photos.saveHint")}
            variant="secondary"
            disabled={uploading || adding || held}
            loading={saving}
            onPress={photos.save}
            testID={`${testID}-save`}
          />
        ) : null}
        <Button
          label={t(count > 0 ? "proJobs.photos.addMore" : "proJobs.photos.add")}
          accessibilityLabel={t(
            count > 0 ? `proJobs.photos.${kind}.addMoreLabel` : `proJobs.photos.${kind}.addLabel`,
          )}
          variant={ready > 0 ? "ghost" : "secondary"}
          disabled={full || saving || held}
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
