import type { components } from "@jack/shared";

/** The BDC's actions on a request (#82): what the card shows and the panel sends. */
export type Note = components["schemas"]["NoteOut"];
export type Followup = components["schemas"]["FollowupOut"];
export type FollowupItem = components["schemas"]["FollowupItem"];
export type StaffMember = components["schemas"]["StaffMemberOut"];
type RequestStatus = components["schemas"]["RequestStatus"];

/** The longest note the API takes (NoteIn.body, NOTE_MAX_LENGTH); it checks again. */
export const NOTE_MAX_LENGTH = 2000;
/** The longest follow-up note the API takes (FollowupIn.note); it checks again. */
export const FOLLOWUP_NOTE_MAX_LENGTH = 500;

/**
 * The statuses in which the API classifies a request: before it is sent to pros. Mirrored to
 * offer Classify only then; the API stays the guard (409 request_not_classifiable).
 */
export const CLASSIFIABLE_STATUSES: readonly RequestStatus[] = ["received", "reviewing"];

export function classifiable(status: RequestStatus): boolean {
  return CLASSIFIABLE_STATUSES.includes(status);
}

/** The outcomes an action can end with, each with its own calm message (never the API's text). */
export const OPS_ERRORS = [
  "request_held",
  "forbidden",
  "request_not_found",
  "request_not_classifiable",
  "category_inactive",
  "followup_due_out_of_range",
  "assignee_not_staff",
  "followup_not_found",
  "rate_limited",
  "validation_error",
  "note_empty",
  "note_too_long",
  "due_invalid",
  "due_past",
  "due_too_far",
  "unconfirmed",
  "unavailable",
] as const;
export type OpsError = (typeof OPS_ERRORS)[number];

/** An action's outcome: `saved` once the API took it, so the control can say so. */
export type OpsState = { error: OpsError | null; saved: boolean };

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The zone's offset from UTC at `instant`, in minutes (New York in winter: -300). */
function offsetMinutes(instant: number, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instant));
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(
    part("year"),
    part("month") - 1,
    part("day"),
    part("hour"),
    part("minute"),
    part("second"),
  );
  return Math.round((asUtc - instant) / 60_000);
}

/**
 * The instant a wall-clock `day` (YYYY-MM-DD) and `time` (HH:MM) name in `zone`, with the
 * zone's own offset on that day (DST-safe), or null when they are not a real day and time. A
 * time the spring change skips moves forward an hour, as clocks do; one the autumn change
 * repeats is the first of the two.
 */
export function zonedInstant(day: string, time: string, zone: string): Date | null {
  if (!DAY.test(day) || !TIME.test(time)) return null;
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  const [hour, minute] = time.split(":").map(Number) as [number, number];
  const wall = Date.UTC(year, month - 1, date, hour, minute);
  const check = new Date(wall);
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== date) return null;
  // A first guess with the offset at the wall time read as UTC, then once more with the offset
  // at that guess. The second answer stands when its own offset agrees; when it does not, the
  // wall time is in the spring gap and the first guess (an hour later on the clock) stands.
  const first = wall - offsetMinutes(wall, zone) * 60_000;
  const second = wall - offsetMinutes(first, zone) * 60_000;
  return new Date(offsetMinutes(second, zone) === offsetMinutes(first, zone) ? second : first);
}

/** Why a follow-up's due time cannot be sent, as the API would refuse it. */
export function dueError(
  due: Date | null,
  nowMs: number,
  maxDays: number,
): "due_invalid" | "due_past" | "due_too_far" | null {
  if (due === null) return "due_invalid";
  if (due.getTime() <= nowMs) return "due_past";
  if (due.getTime() > nowMs + maxDays * 86_400_000) return "due_too_far";
  return null;
}

/** The day (YYYY-MM-DD) an instant falls on in `zone`. */
export function dayIn(instant: Date | number, zone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(instant));
}

/** How a follow-up's due time reads: past (red), today in the business zone (amber), later. */
export type DueTone = "overdue" | "today" | "later";

export function dueTone(dueAt: string, nowMs: number, zone: string): DueTone {
  const due = Date.parse(dueAt);
  if (due < nowMs) return "overdue";
  return dayIn(due, zone) === dayIn(nowMs, zone) ? "today" : "later";
}
