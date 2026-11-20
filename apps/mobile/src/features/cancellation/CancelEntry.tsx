import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text } from "react-native";

import { RetryLine } from "@/features/disputes/RetryLine";
import type { CustomerJob } from "@/features/jobs/phase";

import { isRateLimited, refusalOf, useCancelPreview } from "./api";

type CancelEntryProps = {
  job: CustomerJob;
  /** When the job was last answered: a failed check is read again with each new answer. */
  updatedAt: number;
  onPress: () => void;
};

/**
 * "Cancel job", a quiet text action among the job's actions, shown only while the API's preview
 * answers (`cancel-preview`): never on the phone's own reckoning. While the preview is unknown
 * the action is left out (loading, a refusal: the job cannot be cancelled now). A read that
 * failed, over an earlier answer or not, says so with a retry (the API asked to wait, a 429, in
 * its own words) and is read again with each new answer for the job, so the action comes back on
 * its own once the API answers. The job moving on (the pro set off: cancelling now costs a fee)
 * reads it again too.
 */
export function CancelEntry({ job, updatedAt, onPress }: CancelEntryProps) {
  const { t } = useTranslation();
  const { data, error, isError, isFetching, refetch } = useCancelPreview(job.id);
  const failed = isError && refusalOf(error) === null;
  const limited = failed && isRateLimited(error);

  const statusSeen = useRef(job.status);
  useEffect(() => {
    if (statusSeen.current === job.status) return;
    statusSeen.current = job.status;
    void refetch();
  }, [job.status, refetch]);
  const answerSeen = useRef(updatedAt);
  useEffect(() => {
    if (answerSeen.current === updatedAt) return;
    answerSeen.current = updatedAt;
    if (failed) void refetch();
  }, [updatedAt, failed, refetch]);

  if (failed) {
    return (
      <RetryLine
        message={t(limited ? "cancellation.entryBusy" : "cancellation.entryFailed")}
        busy={isFetching}
        onRetry={() => void refetch()}
        testID="job-cancel-check-failed"
      />
    );
  }
  if (data === undefined || refusalOf(error) !== null) return null;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      className="min-h-12 justify-center self-start"
      testID="job-cancel"
    >
      <Text className="text-callout font-semibold text-navy-900 underline">
        {t("cancellation.entry")}
      </Text>
    </Pressable>
  );
}
