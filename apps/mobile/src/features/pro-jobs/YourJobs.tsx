import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";

import { Card, Skeleton, StatusBadge, StatusBadgeSkeleton, TextSkeleton } from "@/components/ui";
import { categoryLabel, formatTimeOfDay } from "@/features/opportunities/format";
import { RetryNotice } from "@/features/opportunities/RetryNotice";
import { formatLocale, joinFacts } from "@/features/quotes/format";
import { useGuardedPush } from "@/features/quotes/navigation";
import { useSettledError } from "@/features/quotes/useRequestQuotes";
import { continuousCorners } from "@/theme";

import { proJobHref, useProJobs } from "./api";
import { customerName, dayLabel } from "./format";
import { jobStep, STEP_TONE, type ProJob } from "./phase";

// Shown to sighted users only: the row's label already says it all.
const VISUAL_ONLY = {
  accessibilityElementsHidden: true,
  importantForAccessibility: "no-hide-descendants",
} as const;

/** The date tile's side at font scale 1 (the kit's `IconTile` md); it grows with the text. */
const TILE_SIDE = 56;

type RowText = {
  status: string;
  time: string;
  category: string;
  /** "Maria · Fort Lauderdale", or the city alone. */
  place: string;
  label: string;
};

function rowText(t: TFunction, job: ProJob, now: number): RowText {
  const locale = formatLocale();
  const at = Date.parse(job.scheduled_start_at);
  const status = t(`proJobs.status.${jobStep(job)}`);
  const time = formatTimeOfDay(at, locale);
  const when = t("proJobs.when", { day: dayLabel(t, at, now, locale), time });
  const category = categoryLabel(t, job.category);
  const name = customerName(job);
  const city = job.address?.city ?? null;
  const place = joinFacts([name, city].filter((part): part is string => Boolean(part)));
  const what = name ? t("proJobs.yourJobs.for", { category, name }) : category;
  const label = t("proJobs.yourJobs.row", {
    status,
    when,
    what: city ? `${what}, ${city}` : what,
  });
  return { status, time, category, place, label };
}

/** The job's day as a calendar leaf: the month over the day of the month. */
function DateTile({ at }: { at: number }) {
  const locale = formatLocale();
  const date = new Date(at);
  const month = new Intl.DateTimeFormat(locale, { month: "short" }).format(date);
  const day = new Intl.DateTimeFormat(locale, { day: "numeric" }).format(date);
  return (
    <View
      style={[continuousCorners, { minWidth: TILE_SIDE, minHeight: TILE_SIDE }]}
      className="items-center justify-center rounded-md bg-navy-900 px-2 py-1"
    >
      <Text className="text-caption font-semibold uppercase text-green-500">
        {month.replace(".", "")}
      </Text>
      <Text className="text-title-2 text-white">{day}</Text>
    </View>
  );
}

type JobRowProps = {
  job: ProJob;
  /** The time "Today" and "Tomorrow" are read against: when the list was answered. */
  now: number;
  onPress: (job: ProJob) => void;
};

/**
 * One job as a white bubble that opens it: a calendar leaf with its day, then the start time and
 * the step's pill, the category, and the customer's first name with the city.
 */
export function JobRow({ job, now, onPress }: JobRowProps) {
  const { t } = useTranslation();
  const text = rowText(t, job, now);
  const testID = `pro-job-${job.id}`;

  return (
    <Card onPress={() => onPress(job)} accessibilityLabel={text.label} testID={testID}>
      <View {...VISUAL_ONLY} className="flex-row items-center gap-3">
        <DateTile at={Date.parse(job.scheduled_start_at)} />
        <View className="flex-1 gap-1">
          <View className="flex-row flex-wrap items-center gap-x-2 gap-y-1">
            <Text className="text-headline text-navy-900" testID={`${testID}-time`}>
              {text.time}
            </Text>
            <StatusBadge
              label={text.status}
              tone={STEP_TONE[jobStep(job)]}
              testID={`${testID}-status`}
            />
          </View>
          <Text className="text-callout text-navy-900" testID={`${testID}-category`}>
            {text.category}
          </Text>
          {text.place ? (
            <Text className="text-footnote text-gray-500" testID={`${testID}-place`}>
              {text.place}
            </Text>
          ) : null}
        </View>
      </View>
    </Card>
  );
}

/** A row-shaped placeholder: the date leaf, the time beside a pill, two lines under them. */
function JobRowSkeleton() {
  const { t } = useTranslation();
  return (
    <Card>
      <View className="flex-row items-center gap-3">
        <Skeleton width={TILE_SIDE} height={TILE_SIDE} radius="md" />
        <View className="flex-1 gap-1">
          <View className="flex-row flex-wrap items-center gap-x-2 gap-y-1">
            <TextSkeleton type="headline" width="30%" />
            <StatusBadgeSkeleton label={t("proJobs.status.scheduled")} />
          </View>
          <TextSkeleton type="callout" width="50%" />
          <TextSkeleton type="footnote" width="60%" />
        </View>
      </View>
    </Card>
  );
}

/**
 * "Your jobs" on the pro's home (#63), above the opportunities: the active jobs, soonest first,
 * each opening its job screen. Loading shows one row-shaped placeholder, a failure a retry (the
 * opportunities under it still load), and no jobs a line that says how one arrives.
 */
export function YourJobs({ testID = "your-jobs" }: { testID?: string }) {
  const { t } = useTranslation();
  const { data, error, isFetching, refetch, dataUpdatedAt } = useProJobs();
  const shownError = useSettledError(data, error);
  const push = useGuardedPush();
  const open = (job: ProJob) => push(proJobHref(job.id));

  return (
    <View className="gap-3" testID={testID}>
      <Text accessibilityRole="header" className="text-headline text-navy-900">
        {t("proJobs.yourJobs.title")}
      </Text>
      {data === undefined && shownError === null ? (
        <View
          accessible
          accessibilityRole="progressbar"
          accessibilityLabel={t("proJobs.yourJobs.loading")}
          testID={`${testID}-loading`}
        >
          <View {...VISUAL_ONLY}>
            <JobRowSkeleton />
          </View>
        </View>
      ) : data === undefined ? (
        <RetryNotice
          message={t("proJobs.yourJobs.error")}
          action={t("proJobs.yourJobs.retry")}
          onRetry={() => void refetch()}
          busy={isFetching}
          testID={`${testID}-error`}
        />
      ) : data.length === 0 ? (
        <View
          accessible
          style={continuousCorners}
          className="gap-1 rounded-lg bg-navy-900/5 p-4"
          testID={`${testID}-empty`}
        >
          <Text className="text-callout font-semibold text-navy-900">
            {t("proJobs.yourJobs.empty.title")}
          </Text>
          <Text className="text-callout text-navy-900">{t("proJobs.yourJobs.empty.body")}</Text>
        </View>
      ) : (
        data.map((job) => <JobRow key={job.id} job={job} now={dataUpdatedAt} onPress={open} />)
      )}
    </View>
  );
}
