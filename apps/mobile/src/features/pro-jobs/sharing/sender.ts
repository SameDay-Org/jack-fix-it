import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";

import {
  ApiError,
  apiPut,
  isCurrentGeneration,
  onSignOut,
  SessionExpiredError,
  type PutBody,
} from "@/api";
import i18n from "@/i18n";
import { tokens } from "@/theme";

import { jobStep, type ProJob } from "../phase";
import { sharingConfig } from "./config";

/** The one task that sends the pro's position: one name, so there are never two at once. */
export const SHARING_TASK = "jack-pro-location";

type Shared = { readonly jobId: string; readonly generation: number };
type Ping = PutBody<"/v1/jobs/{job_id}/pro-location">;
type Fixes = { locations?: Location.LocationObject[] };

/** A fix up to this share of the interval early still goes: the system's timing drifts. */
const EARLY_SHARE = 0.1;
/** The API's ranges for the optional fields (`ProLocationIn`); a value outside them is left out. */
const MAX_ACCURACY_M = 10_000;
const FULL_TURN_DEG = 360;
/** The answers that end sharing for a job: not this pro's, gone, or not on the way any more. */
const REFUSED = new Set([403, 404, 409]);

// The app keeps no position, and what it keeps about sharing lives in memory only: a relaunch or
// a reload starts with nothing chosen and nothing shared, so a task the system restored stops at
// its first fix until the pro shares again.
let shared: Shared | null = null;
let lastSentAt = Number.NEGATIVE_INFINITY;
let sending = false;
// Jobs the pro chose to share this session (the explanation's Continue, or the job screen's line):
// sharing never starts without that choice, whatever the permission already allows.
const chosen = new Set<string>();
// Jobs that left the way this session (or that the API refused): a job never comes back on it.
const ended = new Set<string>();
// Starts and stops run one at a time, in the order asked.
let queue: Promise<void> = Promise.resolve();
// Who listens for the shared job (the job screen's line).
const listeners = new Set<() => void>();

function serially(step: () => Promise<void>): Promise<void> {
  queue = queue.then(step).catch(() => undefined);
  return queue;
}

function setShared(next: Shared | null): void {
  if (next === shared) return;
  shared = next;
  listeners.forEach((listener) => listener());
}

/** Calls `listener` whenever the shared job changes; returns the unsubscribe. */
export function subscribeSharing(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** On the way and not checked in yet (a locked check-in included): the steps that share. */
export const isSharedStep = (job: ProJob): boolean => {
  const step = jobStep(job);
  return step === "onTheWay" || step === "locked";
};

/** Past the way: checked in, working, done or cancelled. */
const leftTheWay = (job: ProJob): boolean => job.status !== "scheduled" && !isSharedStep(job);

/** The job shared now, if any. */
export const sharedJobId = (): string | null => shared?.jobId ?? null;

/** The pro chose to share `jobId` this session, and it has not left the way. */
export const mayShare = (jobId: string): boolean => chosen.has(jobId) && !ended.has(jobId);

const inRange = (value: number | null, max: number): number | null =>
  value !== null && Number.isFinite(value) && value >= 0 && value <= max ? value : null;

const pingOf = ({ coords, timestamp }: Location.LocationObject): Ping => ({
  lat: coords.latitude,
  lng: coords.longitude,
  accuracy_m: inRange(coords.accuracy, MAX_ACCURACY_M),
  heading_deg: inRange(coords.heading, FULL_TURN_DEG),
  recorded_at: new Date(timestamp).toISOString(),
});

/** The newest of a batch: in the background the system may hold fixes back and hand over several. */
const newest = (fixes: readonly Location.LocationObject[]) =>
  fixes.reduce<Location.LocationObject | undefined>(
    (latest, fix) => (latest === undefined || fix.timestamp > latest.timestamp ? fix : latest),
    undefined,
  );

const refusal = (error: unknown): boolean => error instanceof ApiError && REFUSED.has(error.status);

/**
 * One fix in, at most one ping out: none while the last one is still on its way, none sooner than
 * the interval. A ping that fails is dropped, never queued or retried: the next fix is the next
 * try. Nothing about it is logged.
 */
async function send(fixes: readonly Location.LocationObject[]): Promise<void> {
  const current = shared;
  if (current === null || !isCurrentGeneration(current.generation)) return stopIf(current);
  const fix = newest(fixes);
  const now = Date.now();
  if (fix === undefined || sending) return;
  if (now - lastSentAt < sharingConfig.intervalMs * (1 - EARLY_SHARE)) return;
  sending = true;
  lastSentAt = now;
  try {
    await apiPut("/v1/jobs/{job_id}/pro-location", pingOf(fix), {
      auth: true,
      generation: current.generation,
      params: { job_id: current.jobId },
    });
  } catch (error) {
    // Refused for this session's job: done with it. The session itself ended (a sign-out, a
    // refresh the server refused): stop, and leave the job to the next session.
    if (refusal(error) && isCurrentGeneration(current.generation)) ended.add(current.jobId);
    if (refusal(error) || error instanceof SessionExpiredError) await stopIf(current);
  } finally {
    sending = false;
  }
}

async function stopTask(): Promise<void> {
  if (await Location.hasStartedLocationUpdatesAsync(SHARING_TASK)) {
    await Location.stopLocationUpdatesAsync(SHARING_TASK);
  }
}

/** Stops the task, unless sharing was started again (or for another job) since `expected`. */
function stopIf(expected: Shared | null): Promise<void> {
  return serially(async () => {
    if (shared !== expected) return;
    setShared(null);
    await stopTask();
  });
}

const taskOptions = (): Location.LocationTaskOptions => ({
  accuracy: Location.Accuracy.Balanced,
  timeInterval: sharingConfig.intervalMs,
  // Every interval, moving or not: a pro stopped in traffic stays fresh for the customer (the API
  // forgets a position after 2 minutes). `send` keeps iOS, which ignores the interval, to it.
  distanceInterval: 0,
  // iOS shows that the app uses the location in the background; Android shows the notification.
  showsBackgroundLocationIndicator: true,
  pausesUpdatesAutomatically: false,
  foregroundService: {
    notificationTitle: i18n.t("proJobs.sharing.notification.title"),
    notificationBody: i18n.t("proJobs.sharing.notification.body"),
    notificationColor: tokens.colors["navy-900"],
    // Swiping the app away ends sharing, as closing it does on iOS.
    killServiceOnDestroy: true,
  },
});

/** The phone's location is on; unreadable counts as on (the start reports it otherwise). */
const locationOn = (): Promise<boolean> =>
  Location.hasServicesEnabledAsync().then(
    (on) => on,
    () => true,
  );

/**
 * Shares the pro's position for `jobId` from now on, every `intervalMs`, in the background and
 * with the phone locked too (Android's foreground service with its notification, iOS's location
 * background mode), once the pro chose to (`shareJob`). It asks for no permission: without the
 * "while using" one, or with the phone's location off, it does nothing. Called with the app in
 * front (Android starts no foreground service from the background). The same job again changes
 * nothing; another job takes its place in the same task.
 */
export function startSharing(jobId: string, generation: number): Promise<void> {
  if (!sharingConfig.enabled) return Promise.resolve();
  return serially(async () => {
    if (!mayShare(jobId) || !isCurrentGeneration(generation)) return;
    if (!(await Location.getForegroundPermissionsAsync()).granted) return;
    // Android would register the task with the location off and never ask again for that job.
    if (!(await locationOn())) return;
    const same = shared?.jobId === jobId && shared.generation === generation;
    if (same && (await Location.hasStartedLocationUpdatesAsync(SHARING_TASK))) return;
    if (!isCurrentGeneration(generation) || !mayShare(jobId)) return;
    setShared({ jobId, generation });
    lastSentAt = Number.NEGATIVE_INFINITY;
    try {
      await Location.startLocationUpdatesAsync(SHARING_TASK, taskOptions());
    } catch {
      // Not started (the app left the front first): the next return to the app tries again.
      setShared(null);
    }
  });
}

/** The pro chose to share `jobId` (this session only): it starts as `startSharing` allows. */
export function shareJob(jobId: string, generation: number): Promise<void> {
  if (!sharingConfig.enabled || !isCurrentGeneration(generation)) return Promise.resolve();
  chosen.add(jobId);
  return startSharing(jobId, generation);
}

/** Ends sharing whatever it was for: the pro has no job on the way. */
export function stopSharing(): Promise<void> {
  if (!sharingConfig.enabled) return Promise.resolve();
  setShared(null);
  return serially(async () => {
    setShared(null);
    await stopTask();
  });
}

/**
 * The app saw `job` as it is now. Once it is past the way (checked in, cancelled, any later
 * status) it is never shared again this session, and sharing stops if it was this job's.
 */
export function followJob(job: ProJob): Promise<void> {
  if (!sharingConfig.enabled || !leftTheWay(job)) return Promise.resolve();
  ended.add(job.id);
  return serially(async () => {
    if (shared?.jobId !== job.id) return;
    setShared(null);
    await stopTask();
  });
}

if (sharingConfig.enabled) {
  // At module top level, imported by the root layout: a fix the system delivers finds the task.
  TaskManager.defineTask<Fixes>(SHARING_TASK, async ({ data, error }) => {
    // The system's error carries nothing to act on, and nothing of it is logged.
    if (error !== null || !data?.locations) return;
    await send(data.locations);
  });
  // A sign-out (or another account signing in) ends sharing before anything else is cleared.
  onSignOut(() => {
    chosen.clear();
    ended.clear();
    void stopSharing();
  });
}
