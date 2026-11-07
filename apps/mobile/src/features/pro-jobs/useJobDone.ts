import { useQueryClient } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { useIsFocused } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { isCurrentGeneration, sessionGeneration } from "@/api";
import { announce } from "@/components/ui/focus";
import { useInForeground } from "@/features/jobs/api";

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

/** A wait the screen can cut short: `cancel` ends it at once (the run then sees it is over). */
function cancellableWait(ms: number): { done: Promise<void>; cancel: () => void } {
  let cancel = () => undefined as void;
  const done = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    cancel = () => {
      clearTimeout(timer);
      resolve();
    };
  });
  return { done, cancel };
}

/**
 * Job's done for a working job: posted once however fast the taps. While the after photos' copies
 * are made (`after_photos_processing`) it asks again every `doneRetryIntervalMs`, for at most
 * `doneRetryWindowMs`, then offers Try again. A state is about the after photos it was reached
 * with: a new photo saved since starts over from `idle`.
 *
 * A run belongs to the screen being in front: a blur or the app going to the background ends it
 * at once (no further POST, nothing said or felt), and so do an unmount and a session change. A
 * run ended that way while it waited for the copies starts over, fresh and once, when the screen
 * is back in front; an older run never picks up again. Held by the job screen, which also holds
 * the photo controls while it runs; until the job has loaded there is nothing to post.
 */
export function useJobDone(job: ProJob | undefined) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const { busy, run, mounted } = useSingleFlight();
  const focused = useIsFocused();
  const foreground = useInForeground();
  const front = focused && foreground;
  const afterCount = job?.photos.after.length ?? 0;
  const [reached, setReached] = useState<{ state: DoneState; afterCount: number }>({
    state: "idle",
    afterCount,
  });
  const state = reached.afterCount === afterCount ? reached.state : "idle";
  // Each time the screen leaves the front the epoch moves on: a run from an older one stops.
  const epoch = useRef(0);
  const waiting = useRef<(() => void) | null>(null);
  // A run that the screen leaving cut short while the copies were being made.
  const interrupted = useRef(false);

  useEffect(() => {
    if (front) return;
    epoch.current += 1;
    waiting.current?.();
  }, [front]);

  const done = () =>
    void run(async () => {
      if (!job) return;
      const generation = sessionGeneration();
      const started = epoch.current;
      const inSession = () => mounted.current && isCurrentGeneration(generation);
      const live = () => inSession() && epoch.current === started;
      const { doneRetryIntervalMs, doneRetryWindowMs } = proJobsConfig;
      const tries = Math.floor(doneRetryWindowMs / doneRetryIntervalMs) + 1;
      const set = (next: DoneState) => setReached({ state: next, afterCount });
      // Ended by the screen leaving the front (not by a sign-out or an unmount): start over later.
      const stop = () => {
        if (inSession()) interrupted.current = true;
      };

      for (let attempt = 1; ; attempt += 1) {
        const outcome = await completeJob(client, job.id, generation);
        if (!live()) {
          // Nothing is said or felt away from the screen; what it shows still follows the answer.
          if (outcome.kind === "processing") stop();
          else if (outcome.kind === "photosRequired" && inSession()) set("photosRequired");
          return;
        }
        if (outcome.kind === "done") {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(
            () => undefined,
          );
          return;
        }
        if (outcome.kind === "photosRequired") {
          set("photosRequired");
          announce(t(afterCount > 0 ? "proJobs.done.photosFailed" : "proJobs.done.photosRequired"));
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
        const pause = cancellableWait(doneRetryIntervalMs);
        waiting.current = pause.cancel;
        await pause.done;
        waiting.current = null;
        if (!live()) {
          stop();
          return;
        }
      }
    });

  // Back in front after a cut-short run: one fresh run, once the old one has let go.
  const latest = useRef(done);
  useEffect(() => {
    latest.current = done;
  });
  useEffect(() => {
    if (!front || busy || !interrupted.current) return;
    interrupted.current = false;
    latest.current();
  }, [busy, front]);

  return { state, busy, done };
}
