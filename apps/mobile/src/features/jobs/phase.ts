import type { ApiSchema } from "@jack/shared";
import type { TFunction } from "i18next";

import {
  formatDateTime,
  formatLocale,
  formatMinutes,
  keepTogether,
} from "@/features/quotes/format";

export type CustomerJob = ApiSchema<"CustomerJob">;
export type JobStatus = CustomerJob["status"];
export type JobTimelineEntry = ApiSchema<"JobTimelineEntry">;

/**
 * What the customer sees the job doing. `arrived` is a job still on the way whose pro checked in
 * (the API keeps the status until the pro starts); `finished` is completed and not yet confirmed.
 */
export type JobPhase =
  | "scheduled"
  | "onTheWay"
  | "arrived"
  | "working"
  | "finished"
  | "done"
  | "attention"
  | "cancelled";

const CHECKED_IN = "checked_in";
const STATUS_CHANGED = "status_changed";
const MINUTE_MS = 60_000;

/** The pro checked in with the arrival code: the API cleared the code and logged the event. */
const checkedInAt = (job: CustomerJob): JobTimelineEntry | undefined =>
  job.timeline.find((entry) => entry.type === CHECKED_IN);

/** The latest move into `status`, from the timeline (oldest first). */
function movedTo(job: CustomerJob, status: JobStatus): JobTimelineEntry | undefined {
  return job.timeline.findLast((entry) => entry.type === STATUS_CHANGED && entry.status === status);
}

export function jobPhase(job: CustomerJob): JobPhase {
  switch (job.status) {
    case "scheduled":
      return "scheduled";
    case "on_the_way":
      return checkedInAt(job) ? "arrived" : "onTheWay";
    case "in_progress":
      return "working";
    case "completed":
      return "finished";
    case "confirmed":
    case "paid_out":
      return "done";
    case "disputed":
      return "attention";
    case "refunded":
    case "cancelled":
      return "cancelled";
  }
}

/** Phases the tabs' banner follows: from paid until the customer confirms (or 48 h pass). */
const ACTIVE: ReadonlySet<JobPhase> = new Set([
  "scheduled",
  "onTheWay",
  "arrived",
  "working",
  "finished",
]);
/** Phases the pro moves on their own, so a focused screen asks again (until #65 pushes it). */
const MOVING: ReadonlySet<JobStatus> = new Set(["scheduled", "on_the_way", "in_progress"]);

export const isActive = (job: CustomerJob): boolean => ACTIVE.has(jobPhase(job));
export const isMoving = (job: CustomerJob): boolean => MOVING.has(job.status);

/** The three milestones: On the way, Arrived / working, Done. */
export const MILESTONES = 3;

/** How many milestones the job reached (0 before On my way); null where the bar has no meaning. */
export function milestoneOf(phase: JobPhase): number | null {
  switch (phase) {
    case "scheduled":
      return 0;
    case "onTheWay":
      return 1;
    case "arrived":
    case "working":
      return 2;
    case "finished":
    case "done":
      return 3;
    case "attention":
    case "cancelled":
      return null;
  }
}

/** The pro's first name ("María" of "María P."), or null when the API withholds the name. */
export function firstName(name: string | null): string | null {
  return name?.trim().split(/\s+/)[0] || null;
}

/** The pro as a sentence starts with them ("Dan", "Your pro") and inside one ("your pro"). */
export function proNames(t: TFunction, job: CustomerJob): { lead: string; inline: string } {
  const first = firstName(job.pro.name);
  return {
    lead: first ?? t("jobs.pro.fallback"),
    inline: first ?? t("jobs.pro.fallbackInline"),
  };
}

export type Eta =
  /** Close enough to count down: "in 12 min". */
  | { kind: "close"; at: number; minutes: number }
  | { kind: "later"; at: number }
  /** The time passed and the pro has not checked in. */
  | { kind: "due"; at: number };

/** Where the ETA stands at `now`; null without one (only set by On my way). */
export function etaOf(etaAt: string | null, now: number, closeMinutes: number): Eta | null {
  if (etaAt === null) return null;
  const at = Date.parse(etaAt);
  if (!Number.isFinite(at)) return null;
  const minutes = Math.ceil((at - now) / MINUTE_MS);
  if (minutes <= 0) return { kind: "due", at };
  return minutes <= closeMinutes ? { kind: "close", at, minutes } : { kind: "later", at };
}

/** The local calendar day of an instant, to tell today's times from other days'. */
const dayKey = (at: number): string => {
  const date = new Date(at);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
};

/** "3:40 PM" today, "Tue 3:40 PM" on another day, in the device's time zone. */
export function formatMoment(at: number, now: number, locale: string = formatLocale()): string {
  const sameDay = dayKey(at) === dayKey(now);
  return new Intl.DateTimeFormat(locale, {
    ...(sameDay ? {} : { weekday: "short" }),
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(at));
}

/** A start as short as the banner needs: "Tue 9 AM" on the hour, "Tue 9:30 AM" otherwise. */
export function formatShortStart(iso: string, locale: string = formatLocale()): string {
  const date = new Date(iso);
  return new Intl.DateTimeFormat(locale, {
    weekday: "short",
    hour: "numeric",
    ...(date.getMinutes() === 0 ? {} : { minute: "2-digit" }),
  }).format(date);
}

export type JobText = { headline: string; support: string };

/** The screen's headline and its one supporting line for the job's phase. */
export function jobText(
  t: TFunction,
  job: CustomerJob,
  now: number,
  closeMinutes: number,
  locale: string = formatLocale(),
): JobText {
  const { lead, inline } = proNames(t, job);
  const moment = (entry: JobTimelineEntry | undefined) => {
    const at = entry ? Date.parse(entry.at) : NaN;
    return Number.isFinite(at) ? formatMoment(at, now, locale) : null;
  };

  switch (jobPhase(job)) {
    case "scheduled":
      return {
        // Both forms: a language may put the pro mid-sentence ("Reservaste a tu profesional").
        headline: t("jobs.headline.scheduled", { name: lead, inline }),
        support: t("jobs.support.scheduled", {
          date: formatDateTime(job.scheduled_start_at, locale),
        }),
      };
    case "onTheWay":
      return {
        headline: t("jobs.headline.onTheWay", { name: lead }),
        support: etaText(t, etaOf(job.eta_at, now, closeMinutes), now, locale),
      };
    case "arrived": {
      const at = moment(checkedInAt(job));
      return {
        headline: t("jobs.headline.arrived", { name: lead }),
        support: at ? t("jobs.support.arrived", { time: at }) : t("jobs.support.arrivedNow"),
      };
    }
    case "working": {
      const at = moment(movedTo(job, "in_progress"));
      return {
        headline: t("jobs.headline.working", { name: lead }),
        support: at ? t("jobs.support.working", { time: at }) : t("jobs.support.workingNow"),
      };
    }
    case "finished":
      return {
        headline: t("jobs.headline.finished", { name: lead }),
        support: t("jobs.support.finished"),
      };
    case "done":
      return { headline: t("jobs.headline.done"), support: t("jobs.support.done", { inline }) };
    case "attention":
      return { headline: t("jobs.headline.attention"), support: t("jobs.support.attention") };
    case "cancelled":
      return { headline: t("jobs.headline.cancelled"), support: t("jobs.support.cancelled") };
  }
}

/** "Arriving around 3:40 PM · in 12 min", "Arriving around 3:40 PM", "Arriving any minute now". */
export function etaText(t: TFunction, eta: Eta | null, now: number, locale: string): string {
  if (eta === null) return t("jobs.eta.none");
  const time = formatMoment(eta.at, now, locale);
  switch (eta.kind) {
    case "close":
      // "in 12 min" never breaks inside.
      return t("jobs.eta.close", {
        time,
        countdown: keepTogether(t("jobs.eta.in", { span: formatMinutes(t, eta.minutes) })),
      });
    case "later":
      return t("jobs.eta.later", { time });
    case "due":
      return t("jobs.eta.due");
  }
}

/** The banner's one line; null for a job the banner does not follow. Never the arrival code. */
export function bannerText(
  t: TFunction,
  job: CustomerJob,
  now: number,
  closeMinutes: number,
  locale: string = formatLocale(),
): string | null {
  const { lead } = proNames(t, job);
  switch (jobPhase(job)) {
    case "scheduled":
      return t("jobs.banner.scheduled", {
        name: lead,
        inline: proNames(t, job).inline,
        date: formatShortStart(job.scheduled_start_at, locale),
      });
    case "onTheWay": {
      const eta = etaOf(job.eta_at, now, closeMinutes);
      if (eta?.kind === "close") {
        return t("jobs.banner.onTheWayIn", { name: lead, span: formatMinutes(t, eta.minutes) });
      }
      if (eta?.kind === "later") {
        return t("jobs.banner.onTheWayAt", { name: lead, time: formatMoment(eta.at, now, locale) });
      }
      return eta?.kind === "due"
        ? t("jobs.banner.almostThere", { name: lead })
        : t("jobs.banner.onTheWay", { name: lead });
    }
    case "arrived":
      return t("jobs.banner.arrived", { name: lead });
    case "working":
      return t("jobs.banner.working", { name: lead });
    case "finished":
      return t("jobs.banner.finishedConfirm", { name: lead });
    case "done":
    case "attention":
    case "cancelled":
      return null;
  }
}

/** The banner's line as drawn: `action` marks a tail that asks for something ("confirm"). */
export type BannerParts = { main: string; tail: string | null; action?: boolean };

/**
 * The banner's line in two parts for drawing it: the sentence, which may be cut short, and the
 * time it ends with ("12 min", "Tue 9 AM"), which never is. Read together they are `bannerText`.
 */
export function bannerParts(
  t: TFunction,
  job: CustomerJob,
  now: number,
  closeMinutes: number,
  locale: string = formatLocale(),
): BannerParts | null {
  const { lead, inline } = proNames(t, job);
  switch (jobPhase(job)) {
    case "scheduled":
      return {
        main: t("jobs.headline.scheduled", { name: lead, inline }),
        tail: formatShortStart(job.scheduled_start_at, locale),
      };
    case "onTheWay": {
      const eta = etaOf(job.eta_at, now, closeMinutes);
      if (eta?.kind === "close") {
        return {
          main: t("jobs.banner.onTheWay", { name: lead }),
          tail: formatMinutes(t, eta.minutes),
        };
      }
      if (eta?.kind === "later") {
        return {
          main: t("jobs.banner.onTheWay", { name: lead }),
          tail: formatMoment(eta.at, now, locale),
        };
      }
      break;
    }
    case "finished":
      // The tail is what the customer is asked to do, drawn as a call to it.
      return {
        main: t("jobs.banner.finished", { name: lead }),
        tail: t("jobs.banner.confirm"),
        action: true,
      };
    default:
      break;
  }
  const text = bannerText(t, job, now, closeMinutes, locale);
  return text === null ? null : { main: text, tail: null };
}

/**
 * How far along the drawn route the pro's marker sits, 0 to 1: the share of the On my way span
 * that has passed at `now` (time, never location: the API has no position), held short of the
 * door until the check-in. At the door once arrived or later; at the start before.
 */
export function travelOf(job: CustomerJob, now: number): number {
  const phase = jobPhase(job);
  if (phase === "scheduled" || phase === "attention" || phase === "cancelled") return 0;
  if (phase !== "onTheWay") return 1;
  const left = movedTo(job, "on_the_way");
  const eta = job.eta_at === null ? NaN : Date.parse(job.eta_at);
  if (!left || !Number.isFinite(eta)) return TRAVEL_MIN;
  const start = Date.parse(left.at);
  const share = eta > start ? (now - start) / (eta - start) : 1;
  return Math.min(TRAVEL_MAX, Math.max(TRAVEL_MIN, share));
}

/** A marker that just left still shows it left; one past the ETA still waits short of the door. */
export const TRAVEL_MIN = 0.08;
export const TRAVEL_MAX = 0.9;

export type TimelineItem = { key: string; label: string; time: string };

/** The label of one timeline event; null for an event the customer has no use for. */
function timelineLabel(t: TFunction, entry: JobTimelineEntry): string | null {
  switch (entry.type) {
    case "created":
      return t("jobs.timeline.created");
    case "eta_updated":
      return t("jobs.timeline.etaUpdated");
    case CHECKED_IN:
      return t("jobs.timeline.checkedIn");
    case STATUS_CHANGED:
      switch (entry.status) {
        case "on_the_way":
          return t("jobs.timeline.onTheWay");
        case "in_progress":
          return t("jobs.timeline.started");
        case "completed":
          return t("jobs.timeline.completed");
        case "confirmed":
          return t("jobs.timeline.confirmed");
        case "disputed":
          return t("jobs.timeline.disputed");
        case "refunded":
        case "cancelled":
          return t("jobs.timeline.cancelled");
        default:
          // `scheduled` repeats `created`; `paid_out` is between the platform and the pro.
          return null;
      }
    default:
      // Later steps add event types; an older app shows the ones it knows.
      return null;
  }
}

/** The events the customer reads, newest first, each with its local time. */
export function timelineOf(
  t: TFunction,
  job: CustomerJob,
  now: number,
  locale: string = formatLocale(),
): TimelineItem[] {
  return job.timeline
    .flatMap((entry, index): TimelineItem[] => {
      const label = timelineLabel(t, entry);
      if (label === null) return [];
      const at = Date.parse(entry.at);
      if (!Number.isFinite(at)) return [];
      return [{ key: `${index}-${entry.type}`, label, time: formatMoment(at, now, locale) }];
    })
    .reverse();
}

/** A job with the request it belongs to: what the banner opens. */
export type ActiveJob = { requestId: string; job: CustomerJob };

/** Who goes first when several jobs are active: the pro on the move, then done, then scheduled. */
const PRIORITY: Partial<Record<JobPhase, number>> = {
  onTheWay: 0,
  arrived: 0,
  working: 0,
  finished: 1,
  scheduled: 2,
};

/**
 * The one active job the banner follows: a pro on the way or at work first, then a job waiting
 * for confirmation, then the next scheduled start. Ties keep the given order (newest request
 * first). Null when none is active.
 */
export function pickActive(candidates: readonly ActiveJob[]): ActiveJob | null {
  const active = candidates.filter(({ job }) => isActive(job));
  const rank = ({ job }: ActiveJob) => PRIORITY[jobPhase(job)] ?? Number.MAX_SAFE_INTEGER;
  const start = ({ job }: ActiveJob) => Date.parse(job.scheduled_start_at);
  const sorted = active
    .map((candidate, index) => ({ candidate, index }))
    .sort(
      (a, b) =>
        rank(a.candidate) - rank(b.candidate) ||
        (rank(a.candidate) === PRIORITY.scheduled ? start(a.candidate) - start(b.candidate) : 0) ||
        a.index - b.index,
    );
  return sorted[0]?.candidate ?? null;
}
