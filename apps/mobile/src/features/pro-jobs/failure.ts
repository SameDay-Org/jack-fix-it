import type { QueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";

import { showToast } from "@/components/ui";

import { refreshJob, type StepFailure } from "./api";

/**
 * What a step that did not go through tells the pro. A job that moved on or went away is asked
 * for again (the screen shows where it stands); a session that ended shows nothing, its screens
 * are gone.
 */
export function reportStepFailure(
  t: TFunction,
  client: QueryClient,
  jobId: string,
  generation: number,
  failure: StepFailure,
): void {
  if (failure === "signedOut") return;
  if (failure === "changed" || failure === "gone") refreshJob(client, jobId, generation);
  showToast({ message: t(`proJobs.failure.${failure}`), tone: "danger" });
}
