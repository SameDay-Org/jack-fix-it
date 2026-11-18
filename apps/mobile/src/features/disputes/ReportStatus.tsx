import type { TFunction } from "i18next";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";

import { StatusBadge, TextSkeleton, type StatusTone } from "@/components/ui";
import { sentDay } from "@/features/history/format";
import type { CustomerJob } from "@/features/jobs/phase";

import { useCustomerDispute, type CustomerDispute } from "./api";

const STATUS_TONE: Record<CustomerDispute["status"], StatusTone> = {
  open: "warning",
  resolved: "neutral",
};

/**
 * A report was made on the job: it is disputed now, or was until an admin resolved it (the job
 * moved on to paid out or refunded). Read from the job's own timeline, so a job never reported
 * costs no extra call.
 */
export const hasReport = (job: Pick<CustomerJob, "status" | "timeline">): boolean =>
  job.status === "disputed" ||
  job.timeline.some((entry) => entry.type === "status_changed" && entry.status === "disputed");

/** What the customer is told about where their report stands: open, or how it was resolved. */
export function reportOutcome(t: TFunction, dispute: CustomerDispute): string {
  return dispute.resolution === null
    ? t("disputes.status.openBody")
    : t(`disputes.status.resolution.${dispute.resolution}`);
}

type ReportSummaryProps = {
  dispute: CustomerDispute;
  /** When the report's answer arrived: "Today" is never worded against an older clock. */
  now: number;
  /** The line under the reason: where it stands. */
  outcome?: string;
  testID: string;
};

/** The report in a few lines: its status, the reason, the day it was sent, and where it stands. */
export function ReportSummary({ dispute, now, outcome, testID }: ReportSummaryProps) {
  const { t } = useTranslation();
  const status = t(`disputes.status.${dispute.status}`);
  const reason = t(`disputes.reason.${dispute.reason_code}`);
  const day = sentDay(t, dispute.created_at, now);
  return (
    <View className="gap-2" testID={testID}>
      <View
        accessible
        accessibilityLabel={t("disputes.status.label", { status, reason, day })}
        // The badge drops under the reason when both no longer fit on one line (large text).
        className="flex-row flex-wrap items-center justify-between gap-x-3 gap-y-1"
      >
        <View className="shrink gap-0.5">
          <Text className="text-headline text-navy-900">{reason}</Text>
          <Text className="text-footnote text-gray-500">{day}</Text>
        </View>
        <StatusBadge label={status} tone={STATUS_TONE[dispute.status]} />
      </View>
      {outcome ? (
        <Text className="text-callout text-gray-500" testID={`${testID}-outcome`}>
          {outcome}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * "Report sent" on the customer's job screen (#75): the report the customer made, while it is
 * open and once an admin resolved it. Loading draws its lines' place; a failed read says so with a
 * retry, and the job stays usable around it. The job's status moving on (disputed to paid out or
 * refunded) is the resolution landing: the report is read again then, even with the block on
 * screen all along.
 */
export function ReportStatus({ job }: { job: CustomerJob }) {
  const { t } = useTranslation();
  const { data, isError, isFetching, refetch, dataUpdatedAt } = useCustomerDispute(job.id);
  const dispute = data?.dispute ?? null;
  const seenStatus = useRef(job.status);
  useEffect(() => {
    if (seenStatus.current === job.status) return;
    seenStatus.current = job.status;
    void refetch();
  }, [job.status, refetch]);
  if (data && dispute === null) return null;

  return (
    <View className="gap-3 border-t border-gray-500/15 pt-4" testID="job-report">
      <Text accessibilityRole="header" className="text-title-2 text-navy-900">
        {t("disputes.status.title")}
      </Text>
      {dispute ? (
        <ReportSummary
          dispute={dispute}
          now={dataUpdatedAt}
          outcome={reportOutcome(t, dispute)}
          testID="job-report-summary"
        />
      ) : isError ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ busy: isFetching }}
          disabled={isFetching}
          onPress={() => void refetch()}
          className="min-h-12 justify-center self-start"
          testID="job-report-error"
        >
          <Text className="text-callout text-gray-500">
            {`${t("disputes.status.loadFailed")} `}
            <Text className="font-semibold text-navy-900 underline">
              {t("disputes.status.retry")}
            </Text>
          </Text>
        </Pressable>
      ) : (
        <View className="gap-2" testID="job-report-loading">
          <TextSkeleton type="headline" width="60%" />
          <TextSkeleton type="footnote" width="30%" />
        </View>
      )}
    </View>
  );
}
