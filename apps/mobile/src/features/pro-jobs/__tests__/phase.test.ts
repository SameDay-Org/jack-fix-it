import { isActiveJob, jobStep, soonestFirst, STEP_TONE, type JobStep, type ProJob } from "../phase";
import { arrived, hoursFromNow, jobN, minutesFromNow, onTheWay, proJob, working } from "./helpers";

type JobStatus = ProJob["status"];

const ALL_STATUSES: readonly JobStatus[] = [
  "scheduled",
  "on_the_way",
  "in_progress",
  "completed",
  "confirmed",
  "paid_out",
  "disputed",
  "refunded",
  "cancelled",
];
const ALL_STEPS: readonly JobStep[] = [
  "scheduled",
  "onTheWay",
  "locked",
  "arrived",
  "working",
  "done",
  "closed",
];

describe("jobStep", () => {
  it.each<[JobStatus, JobStep]>([
    ["scheduled", "scheduled"],
    ["in_progress", "working"],
    ["completed", "done"],
    ["confirmed", "done"],
    ["paid_out", "done"],
    ["disputed", "done"],
    ["refunded", "closed"],
    ["cancelled", "closed"],
  ])("draws a %s job as %s", (status, step) => {
    expect(jobStep(proJob({ status }))).toBe(step);
  });

  it("is on the way until the pro checks in, then arrived", () => {
    expect(jobStep(onTheWay())).toBe("onTheWay");
    expect(jobStep(arrived())).toBe("arrived");
  });

  it("is locked when wrong codes locked the check-in before it happened", () => {
    expect(jobStep(onTheWay({ arrival_code_locked: true }))).toBe("locked");
  });

  it("keeps a check-in even when the API reports a lock with it", () => {
    expect(jobStep(arrived({ arrival_code_locked: true }))).toBe("arrived");
  });

  it("never reads a check-in or a lock on a started job", () => {
    expect(jobStep(working({ arrival_code_locked: true }))).toBe("working");
  });

  it("maps every status the API can send", () => {
    for (const status of ALL_STATUSES) {
      expect(ALL_STEPS).toContain(jobStep(proJob({ status })));
    }
  });
});

describe("isActiveJob", () => {
  it.each(ALL_STATUSES)("lists a %s job only while there is still work to do", (status) => {
    const active = status === "scheduled" || status === "on_the_way" || status === "in_progress";
    expect(isActiveJob(proJob({ status }))).toBe(active);
  });
});

describe("soonestFirst", () => {
  it("orders the jobs by scheduled start, soonest first", () => {
    const later = jobN(1, { scheduled_start_at: hoursFromNow(5) });
    const soon = jobN(2, { scheduled_start_at: minutesFromNow(30) });
    const past = jobN(3, { scheduled_start_at: hoursFromNow(-1) });
    expect(soonestFirst([later, soon, past]).map((job) => job.id)).toEqual([
      past.id,
      soon.id,
      later.id,
    ]);
  });

  it("breaks a tie on the start by id, so two answers never shuffle the list", () => {
    const start = hoursFromNow(2);
    const a = jobN(4, { scheduled_start_at: start });
    const b = jobN(7, { scheduled_start_at: start });
    // The same instant written with an offset still ties.
    const c = jobN(5, { scheduled_start_at: start.replace("Z", "+00:00") });
    expect(soonestFirst([b, c, a]).map((job) => job.id)).toEqual([a.id, c.id, b.id]);
    expect(soonestFirst([a, b, c]).map((job) => job.id)).toEqual([a.id, c.id, b.id]);
  });

  it("returns a new list and leaves the API's page as it was", () => {
    const page = Object.freeze([
      jobN(1, { scheduled_start_at: hoursFromNow(4) }),
      jobN(2, { scheduled_start_at: hoursFromNow(1) }),
    ]);
    const sorted = soonestFirst(page);
    expect(sorted).not.toBe(page);
    expect(page.map((job) => job.id)).toEqual([jobN(1).id, jobN(2).id]);
    expect(sorted.map((job) => job.id)).toEqual([jobN(2).id, jobN(1).id]);
  });

  it("handles an empty list", () => {
    expect(soonestFirst([])).toEqual([]);
  });
});

describe("STEP_TONE", () => {
  it("gives every step a status pill tone", () => {
    expect(Object.keys(STEP_TONE).sort()).toEqual([...ALL_STEPS].sort());
    for (const step of ALL_STEPS) {
      expect(["neutral", "info", "success", "warning", "danger", "brand"]).toContain(
        STEP_TONE[step],
      );
    }
  });

  it("marks a locked check-in as danger", () => {
    expect(STEP_TONE.locked).toBe("danger");
  });
});
