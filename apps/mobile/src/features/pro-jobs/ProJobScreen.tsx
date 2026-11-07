import { useQueryClient } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { router, useIsFocused, useLocalSearchParams } from "expo-router";
import type { TFunction } from "i18next";
import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Linking, ScrollView, Text, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { sessionGeneration } from "@/api";
import {
  Button,
  IconTile,
  Notice,
  Screen,
  showToast,
  Skeleton,
  StatusBadge,
  StatusBadgeSkeleton,
  TextSkeleton,
} from "@/components/ui";
import { announce } from "@/components/ui/focus";
import { BackButton } from "@/features/auth/components/BackButton";
import { categoryLabel, categoryTileProps, formatTimeOfDay } from "@/features/opportunities/format";
import { RetryNotice } from "@/features/opportunities/RetryNotice";
import { StateCard } from "@/features/opportunities/StateCard";
import { useRefreshExpiredMedia } from "@/features/opportunities/useOpportunity";
import { formatLocale, formatMoneyExact } from "@/features/quotes/format";
import { useGuardedPush } from "@/features/quotes/navigation";
import { useSettledError } from "@/features/quotes/useRequestQuotes";
import { bubbleShadow, continuousCorners } from "@/theme";

import { isJobGone, startJob, stepFailure, useProJob, useSingleFlight } from "./api";
import { reportStepFailure } from "./failure";
import { addressLines, addressText, customerName, dayLabel, mapsUrl, whenLabel } from "./format";
import { JobPhotoSection } from "./JobPhotoSection";
import { jobStep, STEP_TONE, type JobStep, type ProJob } from "./phase";
import { useJobDone, type DoneState } from "./useJobDone";

/** The icon tile's side (`IconTile` md), for the skeleton. */
const TILE_SIDE = 56;
/** The steps with an action, held in the dock under the page. */
const DOCKED_STEPS: readonly JobStep[] = ["scheduled", "onTheWay", "arrived", "working"];
/** The steps that take before photos (the API: on the way or working); a locked check-in waits. */
const BEFORE_PHOTO_STEPS: readonly JobStep[] = ["onTheWay", "arrived", "working"];
/** The dock's padding under its last control, above the bottom safe area (Tailwind 4, 16 dp). */
const DOCK_PADDING = 16;

/** The customer's first name, or "the customer" in the middle of a sentence. */
const nameOf = (t: TFunction, job: ProJob): string =>
  customerName(job) ?? t("proJobs.customerFallback");

/** The time the hero shows for each step, and the label above it. */
function heroTime(job: ProJob, step: JobStep): { label: Exclude<JobStep, "locked">; at: string } {
  switch (step) {
    case "onTheWay":
    case "locked":
      return { label: "onTheWay", at: job.eta_at ?? job.scheduled_start_at };
    case "arrived":
      return { label: "arrived", at: job.checked_in_at ?? job.scheduled_start_at };
    case "working":
      return { label: "working", at: job.started_at ?? job.scheduled_start_at };
    case "done":
      return { label: "done", at: job.completed_at ?? job.scheduled_start_at };
    default:
      return { label: step, at: job.scheduled_start_at };
  }
}

/**
 * Screen readers hear where the job moved to; not on open, only on a change while it is up. A
 * lock is not in the list: its notice announces itself.
 */
const ANNOUNCED: Partial<Record<JobStep, "onTheWay" | "arrived" | "working" | "done">> = {
  onTheWay: "onTheWay",
  arrived: "arrived",
  working: "working",
  done: "done",
};

function useAnnounceStep(job: ProJob | undefined): void {
  const { t } = useTranslation();
  const focused = useIsFocused();
  const announced = useRef<JobStep | null>(null);
  const step = job ? jobStep(job) : null;
  const name = job ? nameOf(t, job) : "";

  // A step reached under a sheet is said once the screen is in front again, after the sheet.
  useEffect(() => {
    if (step === null || !focused) return;
    const previous = announced.current;
    announced.current = step;
    const key = ANNOUNCED[step];
    if (previous !== null && previous !== step && key) {
      announce(t(`proJobs.announce.${key}`, { name }));
    }
  }, [focused, name, step, t]);
}

/**
 * One of the pro's jobs (`/jobs/[id]`, where #65's pushes land), the whole screen for it: when
 * (and the arrival time once on the way), what the pro receives, the customer's first name, the
 * full address with a way into the maps app, the job itself, and the before and after photos. One
 * primary action per step, under the scrolling page: On my way, I've arrived, Start job, Job's
 * done. Asked again on focus and on foreground, so a screen left open never acts on an old step.
 */
export function ProJobScreen() {
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data, error, refetch, isFetching, dataUpdatedAt, valid } = useProJob(id);
  const photos = useMemo(
    () => (data ? [...data.photos.before, ...data.photos.after] : undefined),
    [data],
  );
  // The photos' signed URLs are asked for again when one expires on screen.
  const now = useRefreshExpiredMedia(photos, dataUpdatedAt, refetch);
  const shownError = useSettledError(data, error);
  const gone = !valid || (data === undefined && isJobGone(shownError));
  const refreshFailed = data !== undefined && error !== null;
  // Locked, done and cancelled have nothing to act on: no dock.
  const docked = data !== undefined && !gone && DOCKED_STEPS.includes(jobStep(data));
  useAnnounceStep(data);

  return (
    // With the action dock, the dock pads the bottom safe area itself (its white runs to the edge).
    <Screen bar="light" edges={docked ? [] : undefined} testID="pro-job-screen">
      <ScrollView contentContainerClassName="flex-grow px-4 pb-6">
        <View className="pb-4 pt-2">
          <BackButton fallbackHref="/" />
        </View>
        {gone ? (
          <StateCard
            title={t("proJobs.screen.gone.title")}
            body={t("proJobs.screen.gone.body")}
            action={t("proJobs.screen.gone.home")}
            onAction={() => router.dismissTo("/")}
            testID="pro-job-gone"
          />
        ) : data === undefined && shownError === null ? (
          <JobSkeleton />
        ) : data === undefined ? (
          <StateCard
            title={t("proJobs.screen.error.title")}
            body={t("proJobs.screen.error.body")}
            action={t("proJobs.screen.error.retry")}
            onAction={() => void refetch()}
            busy={isFetching}
            testID="pro-job-error"
          />
        ) : (
          <View className="gap-8">
            {refreshFailed ? (
              <RetryNotice
                message={t("proJobs.screen.refreshFailed")}
                action={t("proJobs.screen.retry")}
                onRetry={() => void refetch()}
                busy={isFetching}
                testID="pro-job-refresh-failed"
              />
            ) : null}
            <JobHero job={data} now={dataUpdatedAt} />
            <JobFacts job={data} />
            {photosFirst(data) ? <JobPhotos job={data} now={now} /> : null}
            <JobAddress job={data} />
            <JobAbout job={data} />
            {photosFirst(data) ? null : <JobPhotos job={data} now={now} />}
          </View>
        )}
      </ScrollView>
      {docked && data ? <JobActions job={data} /> : null}
    </Screen>
  );
}

/**
 * Working and after, the photos are the job's business and come right after what it pays; on the
 * way and checked in, the address and the job come first and the before photos follow them.
 */
const photosFirst = (job: ProJob): boolean => {
  const step = jobStep(job);
  return step !== "onTheWay" && step !== "arrived";
};

/** Before, then after: each editable while the job takes it, else its saved photos (if any). */
function JobPhotos({ job, now }: { job: ProJob; now: number }) {
  const step = jobStep(job);
  return (
    <>
      <JobPhotoSection
        job={job}
        kind="before"
        now={now}
        editable={BEFORE_PHOTO_STEPS.includes(step)}
      />
      <JobPhotoSection job={job} kind="after" now={now} editable={step === "working"} />
    </>
  );
}

/** The line under the title: what to do next, or what happens now. */
function guideText(t: TFunction, job: ProJob, step: Exclude<JobStep, "locked">): string {
  if (step === "working") {
    return t(
      job.photos.after.length > 0
        ? "proJobs.screen.guide.working"
        : "proJobs.screen.guide.workingNoPhoto",
    );
  }
  const name = nameOf(t, job);
  if (step === "done" && job.status === "completed") {
    return t("proJobs.screen.guide.waiting", { name });
  }
  return t(`proJobs.screen.guide.${step}`, { name });
}

function JobHero({ job, now }: { job: ProJob; now: number }) {
  const { t } = useTranslation();
  const locale = formatLocale();
  const step = jobStep(job);
  const time = heroTime(job, step);
  const at = Date.parse(time.at);
  const category = categoryLabel(t, job.category);
  const name = customerName(job);
  // On the way, the day line says when the job was set for; otherwise the hero's own day.
  const day =
    time.label === "onTheWay"
      ? t("proJobs.screen.scheduledFor", {
          when: whenLabel(t, job.scheduled_start_at, now, locale, "inline"),
        })
      : dayLabel(t, at, now, locale);

  return (
    <View className="gap-4" testID="pro-job-hero">
      <View className="flex-row">
        <StatusBadge
          label={t(`proJobs.status.${step}`)}
          tone={STEP_TONE[step]}
          testID="pro-job-status"
        />
      </View>
      <View accessible testID="pro-job-time">
        <Text className="text-footnote text-gray-500">
          {t(`proJobs.screen.time.${time.label}`)}
        </Text>
        <Text className="text-display text-navy-900">{formatTimeOfDay(at, locale)}</Text>
        <Text className="text-callout text-gray-500">{day}</Text>
      </View>
      <Text
        accessibilityRole="header"
        className="text-title-2 text-navy-900"
        testID="pro-job-title"
      >
        {name ? t("proJobs.yourJobs.for", { category, name }) : category}
      </Text>
      {/* What to do next, in the page: the dock holds the actions only, so it stays short at any
          text size. A locked check-in has no action: its notice says what happens next. */}
      {step === "locked" ? (
        <Notice
          tone="danger"
          title={t("proJobs.screen.locked.title")}
          body={t("proJobs.screen.locked.body")}
          testID="pro-job-locked"
        />
      ) : (
        <Text className="text-callout text-navy-900" testID="pro-job-guide">
          {guideText(t, job, step)}
        </Text>
      )}
    </View>
  );
}

/** What the pro receives and who the customer is, side by side with a divider between. */
function JobFacts({ job }: { job: ProJob }) {
  const { t } = useTranslation();
  const { fontScale } = useWindowDimensions();
  const name = customerName(job);
  // Two half-width columns hold a title at the default text size; larger text stacks them, so a
  // name or an amount never breaks mid-word.
  const stacked = fontScale > 1;

  return (
    <View className={stacked ? "gap-4" : "flex-row items-stretch"} testID="pro-job-facts">
      <View
        accessible
        className={stacked ? "gap-0.5" : "flex-1 gap-0.5 pr-4"}
        testID="pro-job-payout"
      >
        <Text className="text-footnote text-gray-500">{t("proJobs.screen.receive")}</Text>
        <Text className="text-title-2 text-navy-900">{formatMoneyExact(job.pro_payout_cents)}</Text>
      </View>
      {name ? (
        <>
          {stacked ? null : <View className="w-px bg-gray-500/20" />}
          <View
            accessible
            className={stacked ? "gap-0.5" : "flex-1 gap-0.5 pl-4"}
            testID="pro-job-customer"
          >
            <Text className="text-footnote text-gray-500">{t("proJobs.screen.customer")}</Text>
            <Text className="text-title-2 text-navy-900">{name}</Text>
          </View>
        </>
      ) : null}
    </View>
  );
}

/**
 * The full address, selectable (press and hold copies it on both platforms), and a way into the
 * phone's maps app. Gone once the job is cancelled or refunded.
 */
function JobAddress({ job }: { job: ProJob }) {
  const { t } = useTranslation();
  const { address } = job;

  const openMaps = () => {
    if (!address) return;
    Linking.openURL(mapsUrl(address)).catch(() =>
      showToast({ message: t("proJobs.screen.mapsFailed"), tone: "danger" }),
    );
  };

  return (
    <View className="gap-2" testID="pro-job-address">
      <Text accessibilityRole="header" className="text-headline text-navy-900">
        {t("proJobs.screen.where")}
      </Text>
      {address ? (
        <>
          <Text selectable className="text-body text-navy-900" testID="pro-job-address-text">
            {addressLines(address).join("\n")}
          </Text>
          <Text className="text-footnote text-gray-500">{t("proJobs.screen.copyHint")}</Text>
          <View className="flex-row pt-1">
            <Button
              label={t("proJobs.screen.openMaps")}
              accessibilityLabel={t("proJobs.screen.openMapsLabel", {
                address: addressText(address),
              })}
              variant="secondary"
              onPress={openMaps}
              testID="pro-job-open-maps"
            />
          </View>
        </>
      ) : (
        <Text className="text-callout text-gray-500" testID="pro-job-no-address">
          {t("proJobs.screen.noAddress")}
        </Text>
      )}
    </View>
  );
}

/** The job as the customer described it, under its category. */
function JobAbout({ job }: { job: ProJob }) {
  const { t } = useTranslation();
  return (
    <View className="gap-3" testID="pro-job-about">
      <Text accessibilityRole="header" className="text-headline text-navy-900">
        {t("proJobs.screen.theJob")}
      </Text>
      <View className="flex-row items-center gap-3">
        <IconTile {...categoryTileProps(job.category)} />
        <Text className="flex-1 text-callout font-semibold text-navy-900">
          {categoryLabel(t, job.category)}
        </Text>
      </View>
      <Text className="text-body text-navy-900" testID="pro-job-description">
        {job.description}
      </Text>
    </View>
  );
}

/** Start job: posted once however fast the taps; a refusal says why and shows the job as it is. */
function useStartJob(jobId: string) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const { busy, run } = useSingleFlight();

  const start = () =>
    void run(async () => {
      const generation = sessionGeneration();
      try {
        await startJob(client, jobId, generation);
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(
          () => undefined,
        );
      } catch (error) {
        reportStepFailure(t, client, jobId, generation, stepFailure(error));
      }
    });

  return { start, busy };
}

/** What the dock says above Job's done, by where it stands; nothing when there is nothing to say. */
function doneMessage(t: TFunction, job: ProJob, state: DoneState): string | null {
  if (state === "processing") return t("proJobs.done.processing");
  if (state === "slow") return t("proJobs.done.slow");
  if (state === "photosRequired" || job.photos.after.length === 0) {
    return t("proJobs.done.photosRequired");
  }
  return null;
}

/**
 * Job's done: closed until an after photo is on the job (the line above it says so). While the
 * photos' copies are made it says so calmly and keeps asking on its own; past the window it
 * offers Try again.
 */
function DoneAction({ job }: { job: ProJob }) {
  const { t } = useTranslation();
  const { state, busy, done } = useJobDone(job);
  const message = doneMessage(t, job, state);

  return (
    <>
      {message ? (
        <Text
          className={
            state === "photosRequired" ? "text-callout text-danger" : "text-callout text-navy-900"
          }
          accessibilityLiveRegion="polite"
          testID="pro-job-done-message"
        >
          {message}
        </Text>
      ) : null}
      <Button
        label={t(state === "slow" ? "proJobs.done.tryAgain" : "proJobs.done.action")}
        size="lg"
        disabled={job.photos.after.length === 0}
        loading={busy}
        onPress={done}
        testID="pro-job-done"
      />
    </>
  );
}

/**
 * The step's one primary action, in a dock under the page (only the steps that have one). A
 * locked check-in has none: it waits for the team, and its notice sits in the page.
 */
function JobActions({ job }: { job: ProJob }) {
  const { t } = useTranslation();
  const step = jobStep(job);
  const push = useGuardedPush();
  const { start, busy } = useStartJob(job.id);
  const { bottom } = useSafeAreaInsets();
  const sheet = (path: "/jobs/[id]/on-the-way" | "/jobs/[id]/check-in") => () =>
    push({ pathname: path, params: { id: job.id } });

  return (
    // A white dock with the bubble's shadow over the page's edge: the page scrolls under its
    // rounded top, so a line cut by it reads as scrolling, not as clipped.
    <View
      style={[bubbleShadow, continuousCorners, { paddingBottom: bottom + DOCK_PADDING }]}
      className="gap-3 rounded-t-xl bg-white px-4 pt-4"
      testID="pro-job-actions"
    >
      {step === "scheduled" ? (
        <Button
          label={t("proJobs.screen.onMyWay")}
          size="lg"
          onPress={sheet("/jobs/[id]/on-the-way")}
          testID="pro-job-on-my-way"
        />
      ) : step === "onTheWay" ? (
        <>
          <Button
            label={t("proJobs.screen.arrived")}
            size="lg"
            onPress={sheet("/jobs/[id]/check-in")}
            testID="pro-job-arrived"
          />
          <Button
            label={t("proJobs.screen.updateEta")}
            variant="ghost"
            size="lg"
            onPress={sheet("/jobs/[id]/on-the-way")}
            testID="pro-job-update-eta"
          />
        </>
      ) : step === "arrived" ? (
        <Button
          label={t("proJobs.screen.start")}
          size="lg"
          loading={busy}
          onPress={start}
          testID="pro-job-start"
        />
      ) : step === "working" ? (
        <DoneAction job={job} />
      ) : null}
    </View>
  );
}

/** The loaded page's rows as placeholders, so nothing jumps when the job arrives. */
function JobSkeleton() {
  const { t } = useTranslation();
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={t("proJobs.screen.loading")}
      testID="pro-job-loading"
    >
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        className="gap-8"
      >
        <View className="gap-4">
          <View className="flex-row">
            <StatusBadgeSkeleton label={t("proJobs.status.scheduled")} />
          </View>
          <View>
            <TextSkeleton type="footnote" width="20%" />
            <TextSkeleton type="display" width="55%" />
            <TextSkeleton type="callout" width="35%" />
          </View>
          <TextSkeleton type="title-2" width="75%" />
        </View>
        <View className="flex-row">
          <View className="flex-1 gap-0.5 pr-4">
            <TextSkeleton type="footnote" width="60%" />
            <TextSkeleton type="title-2" width="70%" />
          </View>
          <View className="flex-1 gap-0.5 pl-4">
            <TextSkeleton type="footnote" width="50%" />
            <TextSkeleton type="title-2" width="60%" />
          </View>
        </View>
        <View className="gap-2">
          <TextSkeleton type="headline" width="25%" />
          <View>
            <TextSkeleton type="body" width="80%" />
            <TextSkeleton type="body" width="65%" />
          </View>
        </View>
        <View className="gap-3">
          <TextSkeleton type="headline" width="30%" />
          <View className="flex-row items-center gap-3">
            <Skeleton width={TILE_SIDE} height={TILE_SIDE} radius="md" />
            <View className="flex-1">
              <TextSkeleton type="callout" width="50%" />
            </View>
          </View>
        </View>
      </View>
    </View>
  );
}
