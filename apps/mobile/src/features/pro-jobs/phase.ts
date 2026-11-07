import type { ApiSchema } from "@jack/shared";

import type { StatusTone } from "@/components/ui";

export type ProJob = ApiSchema<"ProJob">;
export type ProJobPage = ApiSchema<"ProJobPage">;
/** One photo of the job, signed for a short while (`expires_at`). */
export type JobPhoto = ApiSchema<"JobPhotoOut">;
/** Before the work (optional, from On my way) or after it (Job's done needs one). */
export type JobPhotoKind = ApiSchema<"JobPhotoKind">;
type JobStatus = ProJob["status"];

/**
 * Where the pro is in a job, as the job screen draws it, one primary action each:
 * - `scheduled`: paid, not started out yet (On my way);
 * - `onTheWay`: on the way, not checked in (I've arrived);
 * - `locked`: on the way, and too many wrong arrival codes locked the check-in (support resolves it);
 * - `arrived`: checked in with the customer's code, not started (Start job);
 * - `working`: started (before and after photos, then Job's done);
 * - `done`: the pro marked it done, whatever the customer and the payout did since;
 * - `closed`: cancelled or refunded.
 */
export type JobStep =
  "scheduled" | "onTheWay" | "locked" | "arrived" | "working" | "done" | "closed";

const DONE: readonly JobStatus[] = ["completed", "confirmed", "paid_out", "disputed"];

export function jobStep(
  job: Pick<ProJob, "status" | "checked_in_at" | "arrival_code_locked">,
): JobStep {
  switch (job.status) {
    case "scheduled":
      return "scheduled";
    case "on_the_way":
      // A check-in made before a lock (or a lock the API reports afterwards) never takes it back.
      if (job.checked_in_at !== null) return "arrived";
      return job.arrival_code_locked ? "locked" : "onTheWay";
    case "in_progress":
      return "working";
    default:
      return DONE.includes(job.status) ? "done" : "closed";
  }
}

/** The statuses "Your jobs" lists (the API's `active` filter): still to do. */
const ACTIVE: readonly JobStatus[] = ["scheduled", "on_the_way", "in_progress"];

export const isActiveJob = (job: Pick<ProJob, "status">): boolean => ACTIVE.includes(job.status);

/**
 * The jobs by scheduled start, soonest first (the API pages newest first); the id breaks a tie,
 * so the order never shuffles between two answers.
 */
export const soonestFirst = (jobs: readonly ProJob[]): ProJob[] =>
  [...jobs].sort(
    (a, b) =>
      Date.parse(a.scheduled_start_at) - Date.parse(b.scheduled_start_at) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

/** The tone of each step's status pill; its words are `proJobs.status.<step>`. */
export const STEP_TONE: Record<JobStep, StatusTone> = {
  scheduled: "info",
  onTheWay: "brand",
  locked: "danger",
  arrived: "success",
  working: "warning",
  done: "success",
  closed: "neutral",
};
