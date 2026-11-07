import type { Href } from "expo-router";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button } from "@/components/ui";
import { bubbleShadow, continuousCorners } from "@/theme";

import { PhotoHero } from "./AfterPhotos";
import { confirmJobHref, jobPhotosHref } from "./api";
import { useMinuteClock } from "./clock";
import { deadlineText } from "./deadline";
import { MapBack, Sheet } from "./JobChrome";
import { PaidRow } from "./JobDetails";
import { JobMap } from "./JobMap";
import { JobTimeline } from "./JobTimeline";
import { timelineOf, type CustomerJob, type JobText } from "./phase";

const DOCK_PADDING = 12;

type FinishedJobProps = {
  job: CustomerJob;
  requestId: string;
  text: JobText;
  /** The time the words are drawn at (the timeline's days). */
  now: number;
  /** The time the photos are drawn at: an expired URL shows a frame (`useRefreshExpiredMedia`). */
  photosNow: number;
  /** The screen's one guarded push, shared with the dock. */
  push: (href: Href) => void;
};

/**
 * The pro marked the job done (#66): the whole screen is about checking the work. The after
 * photos are the hero, edge to edge (a tap opens one full screen); the sheet says who finished
 * and asks for a look, then what was paid and what happened. The confirmation itself is the
 * dock under the page (`ConfirmDock`). Without a photo to show (none listed yet), the drawn map
 * with its check on the door stands in.
 */
export function FinishedJob({ job, requestId, text, now, photosNow, push }: FinishedJobProps) {
  const { t } = useTranslation();
  const photos = job.photos.after;

  return (
    <View className="flex-grow" testID="job-finished">
      {photos.length > 0 ? (
        <PhotoHero
          photos={photos}
          now={photosNow}
          onOpen={(index) => push(jobPhotosHref(requestId, index))}
        />
      ) : (
        <JobMap phase="finished" travel={1} />
      )}
      <MapBack />
      <Sheet docked testID="job-sheet">
        <View className="gap-2">
          <Text accessibilityRole="header" className="text-title-1 text-navy-900">
            {text.headline}
          </Text>
          <Text className="text-callout text-gray-500" testID="job-support">
            {text.support}
          </Text>
        </View>
        <PaidRow job={job} />
        <JobTimeline items={timelineOf(t, job, now)} />
      </Sheet>
    </View>
  );
}

type ConfirmDockProps = {
  job: CustomerJob;
  requestId: string;
  /** When the job was last answered: the deadline is never worded against an older clock. */
  updatedAt: number;
  push: (href: Href) => void;
};

/**
 * The finished job's one action, docked under the page: "Confirm the job is done", which opens
 * the confirmation sheet, and under it when the job confirms itself if the customer does not
 * answer, in plain words ("Confirms automatically tomorrow at 3:40 PM if you don't answer").
 */
export function ConfirmDock({ job, requestId, updatedAt, push }: ConfirmDockProps) {
  const { t } = useTranslation();
  const { bottom } = useSafeAreaInsets();
  const confirmBy = job.confirm_by === null ? null : Date.parse(job.confirm_by);
  const now = useMinuteClock(updatedAt, confirmBy);
  const deadline = deadlineText(t, job.confirm_by, now);

  return (
    // The white dock with the bubble's shadow over the page's edge, as on the pro's job screen.
    <View
      style={[bubbleShadow, continuousCorners, { paddingBottom: bottom + DOCK_PADDING }]}
      className="gap-3 rounded-t-xl bg-white px-4 pt-4"
      testID="job-confirm-dock"
    >
      <Button
        label={t("jobs.finished.confirm")}
        size="lg"
        onPress={() => push(confirmJobHref(requestId))}
        testID="job-confirm"
      />
      {deadline ? (
        <Text className="text-center text-footnote text-gray-500" testID="job-confirm-deadline">
          {deadline}
        </Text>
      ) : null}
    </View>
  );
}
