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
 * the action is left out (loading, a refusal: the job cannot be cancelled now); a read that failed
 * says so with a retry, and is read again with each new answer for the job. The job moving on
 * (the pro set off: cancelling now costs a fee) reads it again too. A read the API asked to wait
 * for (429) counts as failed even over an earlier answer: the action comes back with the next one.
 */
export function CancelEntry({ job, updatedAt, onPress }: CancelEntryProps) {
  const { t } = useTranslation();
  const { data, error, isError, isFetching, refetch } = useCancelPreview(job.id);
  const limited = isError && isRateLimited(error);
  const failed = isError && refusalOf(error) === null && (data === undefined || limited);

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
