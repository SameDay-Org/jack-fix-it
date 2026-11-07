import { useQueryClient } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { isCurrentGeneration, sessionGeneration } from "@/api";
import { announce } from "@/components/ui/focus";

import { completeJob, useSingleFlight } from "./api";
import { proJobsConfig } from "./config";
import { reportStepFailure } from "./failure";
import type { ProJob } from "./phase";

/**
 * Where Job's done stands:
 * - `idle`: nothing tried, or a try that ended in a toast;
 * - `processing`: the after photos' privacy-safe copies are being made; it asks again on its own;
 * - `slow`: it asked for the whole window and the copies are still not ready; Try again;
 * - `photosRequired`: the API found no after photo the customer can see; add another.
 */
export type DoneState = "idle" | "processing" | "slow" | "photosRequired";

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Job's done for a working job: posted once however fast the taps. While the after photos' copies
 * are made (`after_photos_processing`) it asks again every `doneRetryIntervalMs`, for at most
 * `doneRetryWindowMs`, then offers Try again. A state is about the after photos it was reached
 * with: a new photo saved since starts over from `idle`. Nothing lands after the screen leaves or
 * the session changes.
 */
export function useJobDone(job: ProJob) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const { busy, run, mounted } = useSingleFlight();
  const afterCount = job.photos.after.length;
  const [reached, setReached] = useState<{ state: DoneState; afterCount: number }>({
    state: "idle",
    afterCount,
  });
  const state = reached.afterCount === afterCount ? reached.state : "idle";

  const done = () =>
    void run(async () => {
      const generation = sessionGeneration();
      const live = () => mounted.current && isCurrentGeneration(generation);
      const { doneRetryIntervalMs, doneRetryWindowMs } = proJobsConfig;
      const tries = Math.floor(doneRetryWindowMs / doneRetryIntervalMs) + 1;
      const set = (next: DoneState) => setReached({ state: next, afterCount });

      for (let attempt = 1; ; attempt += 1) {
        const outcome = await completeJob(client, job.id, generation);
        if (!live()) return;
        if (outcome.kind === "done") {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(
            () => undefined,
          );
          return;
        }
        if (outcome.kind === "photosRequired") {
          set("photosRequired");
          announce(t("proJobs.done.photosRequired"));
          return;
        }
        if (outcome.kind === "failure") {
          set("idle");
          reportStepFailure(t, client, job.id, generation, outcome.failure);
          return;
        }
        if (attempt >= tries) {
          set("slow");
          announce(t("proJobs.done.slow"));
          return;
        }
        if (attempt === 1) {
          set("processing");
          announce(t("proJobs.done.processing"));
        }
        await wait(doneRetryIntervalMs);
        if (!live()) return;
      }
    });

  return { state, busy, done };
}
