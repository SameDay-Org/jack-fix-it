import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { router, useIsFocused, useLocalSearchParams, type Href } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshControl, ScrollView, Text, useWindowDimensions, View } from "react-native";

import { apiGet, SessionExpiredError, useSessionGeneration } from "@/api";
import { Button, Milestones, Screen, showToast, Skeleton, TextSkeleton } from "@/components/ui";
import { announce } from "@/components/ui/focus";
import { ChatEntry } from "@/features/chat";
import { useRefreshExpiredMedia } from "@/features/opportunities/useOpportunity";
import { isUuid, useGuardedPush } from "@/features/quotes/navigation";
import { useSettledError } from "@/features/quotes/useRequestQuotes";
import { tokens } from "@/theme";

import { isNoJobYet, useCustomerJob, wasConfirmedHere } from "./api";
import { ArrivalCode } from "./ArrivalCode";
import { useMinuteClock } from "./clock";
import { jobsConfig } from "./config";
import { ConfirmedJob } from "./ConfirmedJob";
import { ConfirmDock, FinishedJob } from "./FinishedJob";
import { MapBack, Sheet } from "./JobChrome";
import { JobMap } from "./JobMap";
import { PaidRow, ProRow } from "./JobDetails";
import { JobTimeline } from "./JobTimeline";
import {
  jobPhase,
  jobText,
  MILESTONES,
  milestoneOf,
  proNames,
  timelineOf,
  travelOf,
  type CustomerJob,
  type JobPhase,
  type JobText,
} from "./phase";

/** The accepted quote behind the job, whose id opens the pro's profile; it never changes. */
const acceptedQuoteQueryOptions = (requestId: string, generation: number) =>
  queryOptions({
    queryKey: ["accepted-quote", requestId, generation] as const,
    queryFn: async ({ signal }) => {
      const { items } = await apiGet("/v1/requests/{request_id}/quotes", {
        auth: true,
        signal,
        generation,
        params: { request_id: requestId },
      });
      return items.find((quote) => quote.status === "accepted")?.id ?? null;
    },
    staleTime: Infinity,
    retry: false,
  });

/** The pro's profile, pushed over the job: its way back says it returns to the job. */
const jobProfileHref = (requestId: string, quoteId: string) => ({
  pathname: "/requests/[id]/quotes/[quoteId]/pro" as const,
  params: { id: requestId, quoteId, from: "job" },
});

/**
 * The customer's ongoing job (`/requests/[id]/job`, #64): the whole screen for the one job. A
 * drawn map runs edge to edge under the status bar with the way back on it; a white sheet rises
 * over its bottom edge with the headline ("Dan is on the way") and one supporting line (the ETA,
 * the scheduled start), the three milestones, the arrival code while the pro is on the way, the
 * pro (to their profile), what was paid and what happened so far. It keeps itself fresh
 * (`useCustomerJob`) and pulls to refresh. A request with no job yet (the payment has not created
 * it) shows that and keeps asking. The chat with the pro opens from under the pro (#74);
 * problems and cancelling are not built yet, so nothing here offers them. Once the pro marks the
 * job done the screen turns to checking the work and confirming it (`FinishedJob` with its
 * `ConfirmDock`, #66), then to the confirmed job (`ConfirmedJob`).
 */
export function JobScreen() {
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const valid = isUuid(id);
  const { data, error, refetch, isFetching, dataUpdatedAt } = useCustomerJob(id, {
    enabled: valid,
  });
  const shownError = useSettledError(data, error);
  const [pulling, setPulling] = useState(false);
  // One guard for the finished job's photos and its dock: a photo tap and Confirm never both open.
  const push = useGuardedPush();
  // A 404 over a finished job on screen (the confirmation found it gone): nothing to confirm.
  const confirmable = data !== undefined && jobPhase(data) === "finished" && !isNoJobYet(error);

  // A pull that fails over a job already on screen keeps it and says so.
  const refresh = async () => {
    setPulling(true);
    const result = await refetch();
    setPulling(false);
    const failed = result.isError && result.data !== undefined;
    if (failed && !(result.error instanceof SessionExpiredError)) {
      showToast({ message: t("jobs.refreshFailed"), tone: "danger" });
    }
  };

  return (
    <Screen bar="hero" edges={[]} testID="job-screen">
      <ScrollView
        className="flex-1"
        contentContainerClassName="flex-grow"
        refreshControl={
          valid ? (
            <RefreshControl
              refreshing={pulling}
              onRefresh={() => void refresh()}
              tintColor={tokens.colors.white}
              colors={[tokens.colors["navy-900"]]}
            />
          ) : undefined
        }
        testID="job-scroll"
      >
        {data ? (
          <JobView
            job={data}
            requestId={id}
            updatedAt={dataUpdatedAt}
            refetch={refetch}
            push={push}
          />
        ) : !valid ? (
          <JobState
            map="bare"
            title={t("jobs.notFound.title")}
            body={t("jobs.notFound.body")}
            action={t("jobs.notFound.home")}
            onAction={() => router.dismissTo("/")}
            testID="job-not-found"
          />
        ) : isNoJobYet(shownError) ? (
          <JobState
            map="route"
            title={t("jobs.booking.title")}
            body={t("jobs.booking.body")}
            testID="job-booking"
          />
        ) : shownError ? (
          <JobState
            map="bare"
            title={t("jobs.error.title")}
            body={t("jobs.error.body")}
            action={t("jobs.error.retry")}
            onAction={() => void refetch()}
            busy={isFetching}
            testID="job-error"
          />
        ) : (
          <JobSkeleton />
        )}
      </ScrollView>
      {data && confirmable ? (
        <ConfirmDock job={data} requestId={id} updatedAt={dataUpdatedAt} push={push} />
      ) : null}
    </Screen>
  );
}

type JobViewProps = {
  job: CustomerJob;
  requestId: string;
  /** When the job's last answer arrived: the words are never drawn against an older clock. */
  updatedAt: number;
  /** Asks for the job again: an expired photo URL comes back fresh. */
  refetch: () => Promise<unknown>;
  /** The screen's one guarded push (`useGuardedPush`). */
  push: (href: Href) => void;
};

/**
 * The job as its phase draws it: the ongoing job, the finished one to check and confirm, or the
 * confirmed one. A step change while the screen is up is said aloud with its new headline, and the
 * customer's own confirmation landing here reads "Thanks! Job confirmed".
 */
function JobView({ job, requestId, updatedAt, refetch, push }: JobViewProps) {
  const { t } = useTranslation();
  const generation = useSessionGeneration();
  const client = useQueryClient();
  const phase = jobPhase(job);
  const ticking = useMinuteClock(updatedAt, job.eta_at === null ? null : Date.parse(job.eta_at));
  // The photos' URLs expire: they are drawn at this clock, which moves exactly when one does and
  // asks for the job again then. The words go on with the minute clock.
  const photosNow = useRefreshExpiredMedia(job.photos.after, updatedAt, refetch);
  const now = Math.max(ticking, photosNow);
  // The thanks is for the customer's own confirmation; the automatic one is just "Job confirmed".
  const justConfirmed = useJustConfirmed(phase, () =>
    wasConfirmedHere(client, requestId, generation),
  );
  const text = jobText(t, job, ticking, jobsConfig.etaCloseMinutes);
  const shown = justConfirmed ? { ...text, headline: t("jobs.headline.thanks") } : text;
  useAnnounceChange(phase, shown.headline);

  if (phase === "finished") {
    return (
      <FinishedJob
        job={job}
        requestId={requestId}
        text={shown}
        now={now}
        photosNow={photosNow}
        push={push}
      />
    );
  }
  if (phase === "done") {
    return (
      <ConfirmedJob
        job={job}
        requestId={requestId}
        text={shown}
        justConfirmed={justConfirmed}
        now={now}
        photosNow={photosNow}
        push={push}
      />
    );
  }
  return (
    <JobContent job={job} requestId={requestId} updatedAt={updatedAt} text={shown} now={ticking} />
  );
}

/**
 * True once the job turned from finished to confirmed while the screen was up, and from then on;
 * a job opened confirmed is not "just" confirmed, nor one the automatic confirmation turned:
 * `confirmedHere` (asked at the turn only) says whether the customer confirmed it from here. Kept while rendering (React's pattern for state
 * derived from the previous render), so the thanks shows from the first confirmed frame.
 */
function useJustConfirmed(phase: JobPhase, confirmedHere: () => boolean): boolean {
  const [seen, setSeen] = useState({ phase, confirmed: false });
  if (seen.phase !== phase) {
    const confirmed =
      phase === "done" && (seen.confirmed || (seen.phase === "finished" && confirmedHere()));
    setSeen({ phase, confirmed });
    return confirmed;
  }
  return seen.confirmed;
}

type JobContentProps = {
  job: CustomerJob;
  requestId: string;
  updatedAt: number;
  text: JobText;
  /** The time the words are drawn at (`useMinuteClock`). */
  now: number;
};

function JobContent({ job, requestId, updatedAt, text, now }: JobContentProps) {
  const { t } = useTranslation();
  const phase = jobPhase(job);
  const { headline, support } = text;
  const reached = milestoneOf(phase);
  const names = proNames(t, job);
  const generation = useSessionGeneration();
  const acceptedQuote = useQuery(acceptedQuoteQueryOptions(requestId, generation));
  const accepted = acceptedQuote.data;
  // A failed look-up is asked again with each new answer for the job (a poll, a pull), so the
  // way to the pro's profile comes back with the connection.
  const { isError: acceptedFailed, refetch: refetchAccepted } = acceptedQuote;
  // The job answer a failure was seen with: only a later one asks again (no burst on the failure).
  const failedWith = useRef<number | null>(null);
  useEffect(() => {
    if (!acceptedFailed) {
      failedWith.current = null;
    } else if (failedWith.current === null) {
      failedWith.current = updatedAt;
    } else if (failedWith.current !== updatedAt) {
      failedWith.current = updatedAt;
      void refetchAccepted();
    }
  }, [acceptedFailed, refetchAccepted, updatedAt]);
  const push = useGuardedPush();

  const milestoneLabels = [
    t("jobs.milestones.onTheWay"),
    t(phase === "arrived" ? "jobs.milestones.arrived" : "jobs.milestones.working"),
    t("jobs.milestones.done"),
  ];

  return (
    <View className="flex-grow">
      <JobMap phase={phase} travel={travelOf(job, now)} />
      <MapBack />
      <Sheet testID="job-sheet">
        <View className="gap-2">
          <Text accessibilityRole="header" className="text-title-1 text-navy-900">
            {headline}
          </Text>
          <Text className="text-callout text-gray-500" testID="job-support">
            {support}
          </Text>
          {phase === "onTheWay" ? (
            <Text className="text-footnote text-gray-500" testID="job-map-note">
              {t("jobs.map.estimate")}
            </Text>
          ) : null}
        </View>
        {reached === null ? null : (
          <Milestones
            labels={milestoneLabels}
            reached={reached}
            label={t("jobs.milestones.label")}
            valueText={
              reached === 0
                ? t("jobs.milestones.none")
                : t("jobs.milestones.value", {
                    current: reached,
                    total: MILESTONES,
                    step: milestoneLabels[reached - 1],
                  })
            }
            testID="job-milestones"
          />
        )}
        {job.arrival_code ? <ArrivalCode code={job.arrival_code} proName={names.inline} /> : null}
        <View className="gap-4">
          <ProRow
            pro={job.pro}
            onPress={accepted ? () => push(jobProfileHref(requestId, accepted)) : undefined}
          />
          <ChatEntry
            jobId={job.id}
            requestId={requestId}
            name={names.inline}
            status={job.status}
            unread={job.unread_messages}
          />
        </View>
        <PaidRow job={job} />
        <JobTimeline items={timelineOf(t, job, now)} />
      </Sheet>
    </View>
  );
}

/**
 * Says the new headline when the job moves on while the screen is up ("Dan has arrived"), so a
 * screen reader hears the step change; the first answer is the screen's own, not a change. A
 * change under a sheet (the confirmation's own) waits until the job screen is focused again, and
 * is queued: the sheet closing moves the screen reader's focus, which would cut it short.
 */
function useAnnounceChange(phase: string, headline: string): void {
  const focused = useIsFocused();
  const previous = useRef(phase);
  const pending = useRef<string | null>(null);
  useEffect(() => {
    if (previous.current !== phase) {
      previous.current = phase;
      pending.current = headline;
    }
    if (focused && pending.current !== null) {
      announce(pending.current);
      pending.current = null;
    }
  }, [focused, headline, phase]);
}

type JobStateProps = {
  /** The map behind the state: the route to the door while a job is on its way to existing. */
  map: "route" | "bare";
  title: string;
  body: string;
  action?: string;
  onAction?: () => void;
  busy?: boolean;
  testID: string;
};

/** A state of the whole screen: the bare map, then what happened and what to do next. */
function JobState({ map, title, body, action, onAction, busy, testID }: JobStateProps) {
  return (
    <View className="flex-grow" testID={testID}>
      <JobMap
        phase={map === "route" ? "scheduled" : "attention"}
        travel={0}
        testID="job-state-map"
      />
      <MapBack />
      <Sheet>
        <View className="gap-2">
          <Text accessibilityRole="header" className="text-title-1 text-navy-900">
            {title}
          </Text>
          <Text className="text-callout text-gray-500">{body}</Text>
        </View>
        {action && onAction ? (
          <Button
            label={action}
            onPress={onAction}
            loading={busy}
            size="lg"
            testID={`${testID}-action`}
          />
        ) : null}
      </Sheet>
    </View>
  );
}

// The skeleton's sample lines, as wide as typical loaded text.
const HEADLINE_WIDTH = "75%";
const SUPPORT_WIDTH = "55%";
const NAME_WIDTH = "40%";
const AVATAR = 48;
const TRACK = 6;

/** The loaded layout's shapes over the navy map box: nothing jumps when the job arrives. */
function JobSkeleton() {
  const { t } = useTranslation();
  const { width } = useWindowDimensions();
  return (
    <View className="flex-grow">
      <View
        accessible
        accessibilityRole="progressbar"
        accessibilityLabel={t("jobs.loading")}
        className="flex-grow"
        testID="job-loading"
      >
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          className="flex-grow"
        >
          <JobMap phase="attention" travel={0} testID="job-loading-map" />
          <Sheet>
            <View className="gap-2" style={{ maxWidth: width }}>
              <TextSkeleton type="title-1" width={HEADLINE_WIDTH} />
              <TextSkeleton type="callout" width={SUPPORT_WIDTH} />
            </View>
            <View className="gap-2">
              <Skeleton height={TRACK} radius="pill" />
              <TextSkeleton type="footnote" width={SUPPORT_WIDTH} />
            </View>
            <View className="flex-row items-center gap-3">
              <Skeleton circle height={AVATAR} />
              <View className="flex-1 gap-1">
                <TextSkeleton type="headline" width={NAME_WIDTH} />
                <TextSkeleton type="footnote" width={SUPPORT_WIDTH} />
              </View>
            </View>
          </Sheet>
        </View>
      </View>
      {/* Outside the hidden shapes: the way back stays reachable while the job loads. */}
      <MapBack />
    </View>
  );
}
