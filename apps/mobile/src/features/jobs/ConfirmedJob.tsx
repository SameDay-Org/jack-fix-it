import type { Href } from "expo-router";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

import { ControlIcon } from "@/components/icons";
import { ChatEntry } from "@/features/chat";
import { RateEntry } from "@/features/reviews";
import { tokens } from "@/theme";

import { BeforePhotos, PhotoThumbs } from "./AfterPhotos";
import { jobPhotosHref } from "./api";
import { MapBack, Sheet } from "./JobChrome";
import { PaidRow } from "./JobDetails";
import { JobTimeline } from "./JobTimeline";
import { proNames, timelineOf, type CustomerJob, type JobText } from "./phase";

// The seal: a lime disc with a navy check, in a soft lime ring, centered on a navy hero.
const HERO_HEIGHT = 220;
const SEAL = 88;
const RING = 136;
const CHECK = 44;
// Where the seal grows from when the confirmation lands while the screen is up.
const SEAL_FROM = 0.6;
const { stepSlideMs } = tokens.motion;

type ConfirmedJobProps = {
  job: CustomerJob;
  requestId: string;
  text: JobText;
  /** The confirmation landed while the screen was up: the seal grows in (not under Reduce Motion). */
  justConfirmed: boolean;
  /** The time the words are drawn at (the timeline's days). */
  now: number;
  /** When the job's last answer arrived, for the before photos' signed URLs. */
  updatedAt: number;
  /** Asks for the job again: an expired photo URL comes back fresh. */
  refetch: () => Promise<unknown>;
  /** The time the photos are drawn at: an expired URL shows a frame. */
  photosNow: number;
  push: (href: Href) => void;
};

/**
 * The job is confirmed (#66; also once paid out): a calm screen. A navy hero holds a lime seal
 * with a check; the sheet says it in one headline ("Thanks! Job confirmed" right after the
 * customer's own confirmation, "Job confirmed" when they come back to it) and one line about the
 * payment, then the way to rate the pro (#77), the after photos, the way back into the chat, what
 * was paid and what happened.
 */
export function ConfirmedJob({
  job,
  requestId,
  text,
  justConfirmed,
  now,
  photosNow,
  updatedAt,
  refetch,
  push,
}: ConfirmedJobProps) {
  const { t } = useTranslation();

  return (
    <View className="flex-grow" testID="job-confirmed">
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        className="items-center justify-center bg-navy-900"
        style={{ height: HERO_HEIGHT }}
        testID="job-confirmed-hero"
      >
        <Seal grow={justConfirmed} />
      </View>
      <MapBack />
      <Sheet testID="job-sheet">
        <View className="gap-2">
          <Text accessibilityRole="header" className="text-title-1 text-navy-900">
            {text.headline}
          </Text>
          <Text className="text-callout text-gray-500" testID="job-support">
            {text.support}
          </Text>
        </View>
        {/* The one thing still asked of the customer, and only once (#77). */}
        <RateEntry jobId={job.id} requestId={requestId} side="customer" />
        <PhotoThumbs
          photos={job.photos.after}
          now={photosNow}
          onOpen={(index) => push(jobPhotosHref(requestId, index))}
        />
        {/* The conversation stays readable once the job is confirmed ("View messages", #74). */}
        <ChatEntry
          jobId={job.id}
          requestId={requestId}
          name={proNames(t, job).inline}
          status={job.status}
          unread={job.unread_messages}
        />
        <PaidRow job={job} />
        <BeforePhotos photos={job.photos} updatedAt={updatedAt} refetch={refetch} />
        <JobTimeline items={timelineOf(t, job, now)} />
      </Sheet>
    </View>
  );
}

/** The check in its ring; it grows in once when `grow` turns on, or simply stands under Reduce Motion. */
function Seal({ grow }: { grow: boolean }) {
  const reduceMotion = useReducedMotion();
  const animate = grow && !reduceMotion;
  // Starts small only when it will grow: a seal opened on a confirmed job stands from the first frame.
  const scale = useSharedValue(animate ? SEAL_FROM : 1);

  useEffect(() => {
    scale.value = animate
      ? withTiming(1, { duration: stepSlideMs, easing: Easing.out(Easing.back(2)) })
      : 1;
  }, [animate, scale]);

  const style = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  return (
    <Animated.View
      className="items-center justify-center rounded-pill bg-green-500/20"
      style={[{ width: RING, height: RING }, style]}
      testID="job-confirmed-seal"
    >
      <View
        className="items-center justify-center rounded-pill bg-green-500"
        style={{ width: SEAL, height: SEAL }}
      >
        <ControlIcon name="check" size={CHECK} color={tokens.colors["navy-900"]} />
      </View>
    </Animated.View>
  );
}
