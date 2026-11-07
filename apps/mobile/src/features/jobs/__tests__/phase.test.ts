import type { TFunction } from "i18next";

import i18n from "@/i18n";

import {
  bannerText,
  etaOf,
  etaText,
  firstName,
  formatMoment,
  isActive,
  isMoving,
  jobPhase,
  jobText,
  milestoneOf,
  MILESTONES,
  pickActive,
  proNames,
  timelineOf,
  travelOf,
  TRAVEL_MAX,
  TRAVEL_MIN,
  type ActiveJob,
  type CustomerJob,
  type JobPhase,
  type JobStatus,
  type JobTimelineEntry,
} from "../phase";

const t = i18n.t.bind(i18n) as TFunction;
const MINUTE_MS = 60_000;
const CLOSE = 60;
const EN = "en-US";
/**
 * NOW is 2:00 PM on Wednesday, Oct 28 2026 in the machine's own time zone, so every expected
 * clock time below reads the same whatever zone Jest runs in.
 */
const NOW = new Date(2026, 9, 28, 14, 0).getTime();
const at = (minutes: number) => NOW + minutes * MINUTE_MS;
const iso = (minutes: number) => new Date(at(minutes)).toISOString();
/** Intl writes a narrow no-break space before PM, and formatMinutes a no-break space: read both as spaces. */
const plain = (text: string | null) => text?.replace(/[  ]/g, " ") ?? null;

const ARRIVAL_CODE = "9786";

const entry = (
  type: string,
  minutes: number,
  status: JobStatus | null = null,
): JobTimelineEntry => ({ type, status, at: iso(minutes) });

const moved = (status: JobStatus, minutes: number) => entry("status_changed", minutes, status);

const BOOKED: JobTimelineEntry[] = [entry("created", -120), moved("scheduled", -120)];

type JobOverrides = Partial<Omit<CustomerJob, "pro">> & { proName?: string | null };

const job = ({ proName = "Dan Smith", ...overrides }: JobOverrides = {}): CustomerJob => ({
  id: "0e5c7a10-0000-4000-8000-000000000064",
  status: "scheduled",
  customer_status: "customerStatus.scheduled",
  // Thursday, Oct 29 at 2:00 PM local.
  scheduled_start_at: iso(24 * 60),
  pro: {
    id: "5a1d2b30-0000-4000-8000-000000000064",
    name: proName,
    rating_avg: "4.8",
    jobs_count: 12,
    years_of_experience: 6,
    verified: true,
  },
  eta_at: null,
  arrival_code: null,
  timeline: BOOKED,
  amount_cents: 18_000,
  tax_cents: 1_485,
  customer_total_cents: 19_485,
  ...overrides,
});

/** One job per phase, each as the API would send it. */
const JOBS: Record<JobPhase, CustomerJob> = {
  scheduled: job(),
  onTheWay: job({
    status: "on_the_way",
    eta_at: iso(30),
    arrival_code: ARRIVAL_CODE,
    timeline: [...BOOKED, moved("on_the_way", -10)],
  }),
  arrived: job({
    status: "on_the_way",
    eta_at: iso(-5),
    timeline: [...BOOKED, moved("on_the_way", -30), entry("checked_in", -5)],
  }),
  working: job({
    status: "in_progress",
    eta_at: iso(-15),
    timeline: [
      ...BOOKED,
      moved("on_the_way", -40),
      entry("checked_in", -15),
      moved("in_progress", -10),
    ],
  }),
  finished: job({ status: "completed" }),
  done: job({ status: "confirmed" }),
  attention: job({ status: "disputed" }),
  cancelled: job({ status: "cancelled" }),
};

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("jobPhase", () => {
  it.each<[JobStatus, JobPhase]>([
    ["scheduled", "scheduled"],
    ["on_the_way", "onTheWay"],
    ["in_progress", "working"],
    ["completed", "finished"],
    ["confirmed", "done"],
    ["paid_out", "done"],
    ["disputed", "attention"],
    ["refunded", "cancelled"],
    ["cancelled", "cancelled"],
  ])("%s reads as %s", (status, phase) => {
    expect(jobPhase(job({ status }))).toBe(phase);
  });

  it("a job still on the way whose pro checked in has arrived", () => {
    expect(jobPhase(JOBS.arrived)).toBe("arrived");
    expect(jobPhase(JOBS.onTheWay)).toBe("onTheWay");
  });
});

describe("milestoneOf", () => {
  it.each<[JobPhase, number | null]>([
    ["scheduled", 0],
    ["onTheWay", 1],
    ["arrived", 2],
    ["working", 2],
    ["finished", 3],
    ["done", 3],
    ["attention", null],
    ["cancelled", null],
  ])("%s reaches %s milestones", (phase, reached) => {
    expect(milestoneOf(phase)).toBe(reached);
  });

  it("has three milestones", () => {
    expect(MILESTONES).toBe(3);
  });
});

describe("isActive and isMoving", () => {
  it.each<[JobStatus, boolean, boolean]>([
    ["scheduled", true, true],
    ["on_the_way", true, true],
    ["in_progress", true, true],
    ["completed", true, false],
    ["confirmed", false, false],
    ["paid_out", false, false],
    ["disputed", false, false],
    ["refunded", false, false],
    ["cancelled", false, false],
  ])("%s: active %s, moving %s", (status, active, moving) => {
    expect(isActive(job({ status }))).toBe(active);
    expect(isMoving(job({ status }))).toBe(moving);
  });

  it("an arrived pro is active and still moving (the status stays on the way)", () => {
    expect(isActive(JOBS.arrived)).toBe(true);
    expect(isMoving(JOBS.arrived)).toBe(true);
  });
});

describe("firstName and proNames", () => {
  it.each<[string | null, string | null]>([
    ["María P.", "María"],
    ["Dan", "Dan"],
    ["  Dan   Smith  ", "Dan"],
    [null, null],
    ["", null],
    ["   ", null],
  ])("%j gives %j", (name, first) => {
    expect(firstName(name)).toBe(first);
  });

  it("names the pro by first name, inside a sentence too", () => {
    expect(proNames(t, job({ proName: "María P." }))).toEqual({ lead: "María", inline: "María" });
  });

  it.each([null, "   "])("falls back to 'Your pro' / 'your pro' for %j", (proName) => {
    expect(proNames(t, job({ proName }))).toEqual({ lead: "Your pro", inline: "your pro" });
  });

  it("falls back in Spanish too", async () => {
    await i18n.changeLanguage("es");
    expect(proNames(t, job({ proName: null })).lead).toBe("Tu profesional");
  });
});

describe("etaOf", () => {
  it("is null without an ETA or with one that does not parse", () => {
    expect(etaOf(null, NOW, CLOSE)).toBeNull();
    expect(etaOf("not a date", NOW, CLOSE)).toBeNull();
  });

  it("counts down within the close window, rounding the minutes up", () => {
    expect(etaOf(iso(12), NOW, CLOSE)).toEqual({ kind: "close", at: at(12), minutes: 12 });
    expect(etaOf(iso(0.5), NOW, CLOSE)).toEqual({ kind: "close", at: at(0.5), minutes: 1 });
    expect(etaOf(iso(CLOSE), NOW, CLOSE)).toEqual({ kind: "close", at: at(CLOSE), minutes: CLOSE });
  });

  it("is later past the close window", () => {
    expect(etaOf(iso(CLOSE + 1), NOW, CLOSE)).toEqual({ kind: "later", at: at(CLOSE + 1) });
    expect(etaOf(iso(20), NOW, 15)).toEqual({ kind: "later", at: at(20) });
  });

  it("is due once the time has come or passed", () => {
    expect(etaOf(iso(0), NOW, CLOSE)).toEqual({ kind: "due", at: NOW });
    expect(etaOf(iso(-7), NOW, CLOSE)).toEqual({ kind: "due", at: at(-7) });
  });
});

describe("formatMoment", () => {
  it("shows the time alone today and the weekday on another day", () => {
    expect(plain(formatMoment(at(100), NOW, EN))).toBe("3:40 PM");
    expect(plain(formatMoment(at(24 * 60 + 100), NOW, EN))).toBe("Thu 3:40 PM");
  });
});

describe("etaText", () => {
  it("words every kind of ETA", () => {
    expect(plain(etaText(t, etaOf(iso(12), NOW, CLOSE), NOW, EN))).toBe(
      "Arriving around 2:12 PM · in 12 min",
    );
    expect(plain(etaText(t, etaOf(iso(90), NOW, CLOSE), NOW, EN))).toBe("Arriving around 3:30 PM");
    expect(etaText(t, etaOf(iso(-1), NOW, CLOSE), NOW, EN)).toBe("Arriving any minute now");
    expect(etaText(t, null, NOW, EN)).toBe("On the way to you");
  });

  it("writes an hour-plus countdown in hours and minutes", () => {
    expect(plain(etaText(t, etaOf(iso(90), NOW, 120), NOW, EN))).toBe(
      "Arriving around 3:30 PM · in 1 h 30 min",
    );
  });
});

describe("jobText", () => {
  it.each<[JobPhase, string, string]>([
    ["scheduled", "Dan is booked", "Scheduled for Thu, Oct 29, 2:00 PM"],
    ["onTheWay", "Dan is on the way", "Arriving around 2:30 PM · in 30 min"],
    ["arrived", "Dan has arrived", "Checked in at 1:55 PM"],
    ["working", "Dan is working", "Started at 1:50 PM"],
    ["finished", "Job's done", "Dan marked the job as done. Take a look at the work."],
    ["done", "Job's done", "Thanks for booking with Jack Fix It."],
    ["attention", "This job needs attention", "A problem was reported on this job."],
    ["cancelled", "This job was cancelled", "Nothing more is needed from you."],
  ])("%s: %s / %s", (phase, headline, support) => {
    const text = jobText(t, JOBS[phase], NOW, CLOSE, EN);
    expect(plain(text.headline)).toBe(headline);
    expect(plain(text.support)).toBe(support);
  });

  it("on the way without an ETA, or once it is due", () => {
    const noEta = job({ status: "on_the_way", timeline: [...BOOKED, moved("on_the_way", -1)] });
    expect(jobText(t, noEta, NOW, CLOSE, EN).support).toBe("On the way to you");
    expect(jobText(t, { ...noEta, eta_at: iso(-2) }, NOW, CLOSE, EN).support).toBe(
      "Arriving any minute now",
    );
  });

  it("working without a logged start says the work is under way", () => {
    const working = job({ status: "in_progress" });
    expect(jobText(t, working, NOW, CLOSE, EN).support).toBe("The work is under way");
  });

  it("an arrival on another day carries the weekday", () => {
    const arrived = job({
      status: "on_the_way",
      timeline: [...BOOKED, entry("checked_in", -24 * 60)],
    });
    expect(plain(jobText(t, arrived, NOW, CLOSE, EN).support)).toBe("Checked in at Tue 2:00 PM");
  });

  it("uses the fallback name without one", () => {
    expect(jobText(t, job({ proName: null }), NOW, CLOSE, EN).headline).toBe("Your pro is booked");
    expect(
      jobText(t, { ...JOBS.finished, pro: { ...JOBS.finished.pro, name: null } }, NOW, CLOSE, EN)
        .support,
    ).toBe("Your pro marked the job as done. Take a look at the work.");
  });

  it("speaks Spanish", async () => {
    await i18n.changeLanguage("es");
    const onTheWay = jobText(t, JOBS.onTheWay, NOW, CLOSE, "es");
    expect(onTheWay.headline).toBe("Dan va en camino");
    expect(plain(onTheWay.support)).toBe("Llegada estimada: 14:30 · en 30 min");

    const scheduled = jobText(t, job({ proName: null }), NOW, CLOSE, "es");
    expect(scheduled.headline).toBe("Reservaste a tu profesional");
    expect(plain(scheduled.support)).toBe("Programado para el jue, 29 oct, 14:00");

    expect(jobText(t, JOBS.cancelled, NOW, CLOSE, "es")).toEqual({
      headline: "Este trabajo se canceló",
      support: "No necesitas hacer nada más.",
    });
  });
});

describe("bannerText", () => {
  it.each<[JobPhase, string | null]>([
    ["scheduled", "Dan is booked · Thu 2 PM"],
    ["onTheWay", "Dan is on the way · 30 min"],
    ["arrived", "Dan has arrived"],
    ["working", "Dan is working"],
    ["finished", "Dan finished the job"],
    ["done", null],
    ["attention", null],
    ["cancelled", null],
  ])("%s: %j", (phase, text) => {
    expect(plain(bannerText(t, JOBS[phase], NOW, CLOSE, EN))).toBe(text);
  });

  it("on the way: a clock time past the close window, almost there once due, plain without an ETA", () => {
    const onTheWay = JOBS.onTheWay;
    expect(plain(bannerText(t, { ...onTheWay, eta_at: iso(90) }, NOW, CLOSE, EN))).toBe(
      "Dan is on the way · 3:30 PM",
    );
    expect(bannerText(t, { ...onTheWay, eta_at: iso(-3) }, NOW, CLOSE, EN)).toBe(
      "Dan is almost there",
    );
    expect(bannerText(t, { ...onTheWay, eta_at: null }, NOW, CLOSE, EN)).toBe("Dan is on the way");
  });

  it("never shows the arrival code, whatever the phase", () => {
    const etas = [iso(30), iso(90), iso(-3), null];
    for (const phase of Object.keys(JOBS) as JobPhase[]) {
      for (const eta_at of etas) {
        const text = bannerText(
          t,
          { ...JOBS[phase], arrival_code: ARRIVAL_CODE, eta_at },
          NOW,
          CLOSE,
          EN,
        );
        expect(text ?? "").not.toContain(ARRIVAL_CODE);
      }
    }
  });

  it("speaks Spanish", async () => {
    await i18n.changeLanguage("es");
    expect(plain(bannerText(t, JOBS.onTheWay, NOW, CLOSE, "es"))).toBe("Dan va en camino · 30 min");
    expect(bannerText(t, job({ status: "completed", proName: null }), NOW, CLOSE, "es")).toBe(
      "Tu profesional terminó el trabajo",
    );
  });
});

describe("travelOf", () => {
  /** On the way since `left` minutes, arriving at `eta` minutes (relative to NOW). */
  const travelling = (left: number | null, eta: number | null): CustomerJob =>
    job({
      status: "on_the_way",
      eta_at: eta === null ? null : iso(eta),
      timeline: left === null ? BOOKED : [...BOOKED, moved("on_the_way", left)],
    });

  it("sits at the start before On my way, and for a job that went wrong", () => {
    expect(travelOf(JOBS.scheduled, NOW)).toBe(0);
    expect(travelOf(JOBS.attention, NOW)).toBe(0);
    expect(travelOf(JOBS.cancelled, NOW)).toBe(0);
  });

  it("sits at the door once arrived and after", () => {
    expect(travelOf(JOBS.arrived, NOW)).toBe(1);
    expect(travelOf(JOBS.working, NOW)).toBe(1);
    expect(travelOf(JOBS.finished, NOW)).toBe(1);
    expect(travelOf(JOBS.done, NOW)).toBe(1);
  });

  it("on the way: the share of the span that passed", () => {
    expect(travelOf(travelling(-10, 10), NOW)).toBeCloseTo(0.5);
    expect(travelOf(travelling(-30, 10), NOW)).toBeCloseTo(0.75);
  });

  it("holds the share between TRAVEL_MIN and TRAVEL_MAX", () => {
    expect(travelOf(travelling(0, 30), NOW)).toBe(TRAVEL_MIN);
    expect(travelOf(travelling(-1, 100), NOW)).toBe(TRAVEL_MIN);
    expect(travelOf(travelling(-30, -5), NOW)).toBe(TRAVEL_MAX);
    expect(travelOf(travelling(-30, 1), NOW)).toBe(TRAVEL_MAX);
  });

  it("an ETA at or before the departure counts as the end of the span", () => {
    expect(travelOf(travelling(-10, -20), NOW)).toBe(TRAVEL_MAX);
    expect(travelOf(travelling(-10, -10), NOW)).toBe(TRAVEL_MAX);
  });

  it("without an ETA or a logged departure it just left", () => {
    expect(travelOf(travelling(-10, null), NOW)).toBe(TRAVEL_MIN);
    expect(travelOf(travelling(null, 10), NOW)).toBe(TRAVEL_MIN);
    expect(travelOf({ ...travelling(-10, 10), eta_at: "soon" }, NOW)).toBe(TRAVEL_MIN);
  });
});

describe("timelineOf", () => {
  const history = job({
    status: "cancelled",
    timeline: [
      entry("created", -300),
      moved("scheduled", -300),
      moved("on_the_way", -60),
      entry("eta_updated", -50),
      entry("checked_in", -40),
      moved("in_progress", -30),
      entry("photo_added", -25),
      moved("completed", -20),
      moved("confirmed", -15),
      moved("paid_out", -12),
      moved("disputed", -10),
      moved("refunded", -5),
      moved("cancelled", -24 * 60 * 2),
    ],
  });

  it("lists what the customer reads, newest first, with local times", () => {
    const items = timelineOf(t, history, NOW, EN).map(({ key, label, time }) => ({
      key,
      label,
      time: plain(time),
    }));
    expect(items).toEqual([
      { key: "12-status_changed", label: "Cancelled", time: "Mon 2:00 PM" },
      { key: "11-status_changed", label: "Cancelled", time: "1:55 PM" },
      { key: "10-status_changed", label: "Problem reported", time: "1:50 PM" },
      { key: "8-status_changed", label: "Confirmed", time: "1:45 PM" },
      { key: "7-status_changed", label: "Marked as done", time: "1:40 PM" },
      { key: "5-status_changed", label: "Started working", time: "1:30 PM" },
      { key: "4-checked_in", label: "Arrived", time: "1:20 PM" },
      { key: "3-eta_updated", label: "New arrival time", time: "1:10 PM" },
      { key: "2-status_changed", label: "On the way", time: "1:00 PM" },
      { key: "0-created", label: "Booked and paid", time: "9:00 AM" },
    ]);
  });

  it("is empty for a job with nothing to read", () => {
    const quiet = job({ timeline: [moved("scheduled", -5), entry("future_event", -1)] });
    expect(timelineOf(t, quiet, NOW, EN)).toEqual([]);
  });

  it("speaks Spanish", async () => {
    await i18n.changeLanguage("es");
    expect(timelineOf(t, JOBS.working, NOW, "es").map(({ label }) => label)).toEqual([
      "Empezó a trabajar",
      "Llegó",
      "En camino",
      "Reservado y pagado",
    ]);
  });
});

describe("pickActive", () => {
  const candidate = (requestId: string, overrides: JobOverrides = {}): ActiveJob => ({
    requestId,
    job: job(overrides),
  });

  it("is null with no candidates or none active", () => {
    expect(pickActive([])).toBeNull();
    expect(
      pickActive([
        candidate("done", { status: "confirmed" }),
        candidate("paid", { status: "paid_out" }),
        candidate("disputed", { status: "disputed" }),
        candidate("refunded", { status: "refunded" }),
        candidate("cancelled", { status: "cancelled" }),
      ]),
    ).toBeNull();
  });

  it.each<JobStatus>(["on_the_way", "in_progress"])(
    "a pro %s goes before a finished job, which goes before a scheduled one",
    (status) => {
      const scheduled = candidate("scheduled");
      const finished = candidate("finished", { status: "completed" });
      const moving = candidate("moving", { status });
      expect(pickActive([scheduled, finished, moving])).toBe(moving);
      expect(pickActive([scheduled, finished])).toBe(finished);
      expect(pickActive([candidate("done", { status: "confirmed" }), scheduled])).toBe(scheduled);
    },
  );

  it("an arrived pro ranks with the ones on the move, and ties keep the given order", () => {
    const arrived: ActiveJob = { requestId: "arrived", job: JOBS.arrived };
    const working = candidate("working", { status: "in_progress" });
    expect(pickActive([arrived, working])).toBe(arrived);
    expect(pickActive([working, arrived])).toBe(working);

    const finishedA = candidate("a", { status: "completed" });
    const finishedB = candidate("b", { status: "completed" });
    expect(pickActive([finishedA, finishedB])).toBe(finishedA);
    expect(pickActive([finishedB, finishedA])).toBe(finishedB);
  });

  it("scheduled jobs: the earliest start first, ties in the given order", () => {
    const later = candidate("later", { scheduled_start_at: iso(48 * 60) });
    const sooner = candidate("sooner", { scheduled_start_at: iso(3 * 60) });
    const soonerToo = candidate("sooner-too", { scheduled_start_at: iso(3 * 60) });
    expect(pickActive([later, sooner, soonerToo])).toBe(sooner);
    expect(pickActive([later, soonerToo, sooner])).toBe(soonerToo);
  });

  it("skips inactive jobs even when they come first", () => {
    const scheduled = candidate("scheduled");
    expect(
      pickActive([
        candidate("cancelled", { status: "cancelled" }),
        candidate("disputed", { status: "disputed" }),
        scheduled,
      ]),
    ).toBe(scheduled);
  });
});
