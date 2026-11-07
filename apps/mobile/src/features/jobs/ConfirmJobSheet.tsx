import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";

import { isCurrentGeneration, sessionGeneration, useSessionGeneration } from "@/api";
import { Button, SheetContent, showToast } from "@/components/ui";
import { announce } from "@/components/ui/focus";
import { stepFailure, useSingleFlight } from "@/features/pro-jobs/api";
import { useSheetExit } from "@/features/pro-jobs/useSheetExit";

import { confirmJob, customerJobQueryOptions, refreshCustomerJob } from "./api";
import { jobPhase, proNames } from "./phase";

/** A failure the sheet stays open for: confirming again is safe (a repeat answers the same). */
type Retryable = "offline" | "failed";

/**
 * "Confirm the job is done?" (`/requests/[id]/confirm`, a fit-to-contents sheet over the finished
 * job, #66): it says what confirming does (the payment is released to the pro), then posts once,
 * however fast the taps. The answer decides the rest:
 * - confirmed: a success haptic, the sheet closes over the confirmed job (the screen under it
 *   turns as it closes, and says "Thanks! Job confirmed" aloud);
 * - the job moved on (409) or is gone (404): the sheet closes, a toast says so, and the job is
 *   asked again, so the screen shows where it stands;
 * - offline or a server error: the sheet stays with the reason, said aloud, and Confirm again.
 * Every step is pinned to the session the tap started in: an answer after a sign-out does nothing
 * (no haptic, no toast, no cache write). The sheet also closes by itself when the job stops being
 * finished under it (a refresh, the automatic confirmation).
 */
export function ConfirmJobSheet() {
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const generation = useSessionGeneration();
  const client = useQueryClient();
  // Read from the screen under the sheet, never fetched here.
  const { data: job } = useQuery({ ...customerJobQueryOptions(id, generation), enabled: false });
  const { busy, run, mounted } = useSingleFlight();
  const { leave, leaving, sameSession } = useSheetExit(generation);
  const [failure, setFailure] = useState<Retryable | null>(null);

  // Opened without a finished job on screen (a stale link), or the job moved on while the sheet
  // was up: there is nothing to confirm.
  const finished = job !== undefined && jobPhase(job) === "finished";
  useEffect(() => {
    if (sameSession && !finished && !busy && !leaving.current) leave();
  }, [busy, finished, leave, leaving, sameSession]);
  if (!job) return null;

  const name = proNames(t, job).inline;

  const confirm = () => {
    void run(async () => {
      setFailure(null);
      const started = sessionGeneration();
      try {
        await confirmJob(client, id, started);
        if (!isCurrentGeneration(started)) return;
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(
          () => undefined,
        );
        if (mounted.current) leave();
      } catch (error) {
        const reason = stepFailure(error);
        if (reason === "signedOut" || !isCurrentGeneration(started)) return;
        if ((reason === "offline" || reason === "failed") && mounted.current) {
          setFailure(reason);
          announce(t(`jobs.confirmSheet.${reason}`));
          return;
        }
        if (reason === "changed" || reason === "gone") refreshCustomerJob(client, id, started);
        showToast({ message: t(`jobs.confirmSheet.${reason}`), tone: "danger" });
        if (mounted.current) leave();
      }
    });
  };

  return (
    <SheetContent
      title={t("jobs.confirmSheet.title")}
      fitToContents
      testID="confirm-job-sheet"
      // In the actions slot, the buttons stay in view when a failure lengthens the body. Full
      // width, one above the other: two pills never squeeze into a row on a narrow phone.
      actions={
        <View className="flex-1 gap-3">
          <Button
            label={t("jobs.confirmSheet.confirm")}
            size="lg"
            loading={busy}
            onPress={confirm}
            testID="confirm-job-send"
          />
          <Button
            label={t("jobs.confirmSheet.notYet")}
            variant="ghost"
            size="lg"
            disabled={busy}
            onPress={leave}
            testID="confirm-job-cancel"
          />
        </View>
      }
    >
      <Text className="text-callout text-gray-500" testID="confirm-job-body">
        {t("jobs.confirmSheet.body", { name })}
      </Text>
      {failure ? (
        <Text className="text-callout text-danger" testID="confirm-job-failure">
          {t(`jobs.confirmSheet.${failure}`)}
        </Text>
      ) : null}
    </SheetContent>
  );
}
