import "@/i18n";

import { waitFor } from "@testing-library/react-native";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";

import { ApiError, apiPut, NetworkError, SessionExpiredError } from "@/api";
import { tokens } from "@/theme";

import { deferred } from "../../../../api/__tests__/helpers";
import { arrived, JOB_ID, jobN, NOW, onTheWay, proJob, working } from "../../__tests__/helpers";
import type { ProJob } from "../../phase";
import { followJob, mayShare, shareJob, SHARING_TASK, sharedJobId, startSharing } from "../sender";

import {
  consoleText,
  deliver,
  fix,
  LAT,
  LNG,
  permission,
  resetLocation,
  starts,
  stops,
} from "./helpers";

jest.mock("@/api", () => ({
  ...jest.requireActual("../../__tests__/helpers").apiMock(),
  apiPut: jest.fn(),
}));
// The permission and the location task (the helpers' `resetLocation` gives them their behavior).
jest.mock("expo-location", () => ({
  getForegroundPermissionsAsync: jest.fn(),
  requestForegroundPermissionsAsync: jest.fn(),
  hasServicesEnabledAsync: jest.fn(),
  enableNetworkProviderAsync: jest.fn(),
  startLocationUpdatesAsync: jest.fn(),
  stopLocationUpdatesAsync: jest.fn(),
  hasStartedLocationUpdatesAsync: jest.fn(),
  Accuracy: { Balanced: 3, High: 4 },
}));
jest.mock("expo-task-manager", () => ({ defineTask: jest.fn() }));
jest.mock("../config", () => ({
  ...jest.requireActual("../config"),
  sharingConfig: { enabled: true, intervalMs: 10_000 },
}));

const { mockSession, mockSignOut } = jest.requireMock<{
  mockSession: { generation: number };
  mockSignOut: () => void;
}>("@/api");

const PING = "/v1/jobs/{job_id}/pro-location";
const SECOND = 1000;
const OTHER_JOB = jobN(7, { status: "on_the_way" }).id;

let now = NOW;
const at = (ms: number) => {
  now = NOW + ms;
};
const pings = () => jest.mocked(apiPut).mock.calls;
/** The body of the nth ping. */
const sent = (index: number) => pings()[index]?.[1];

let task: ReturnType<typeof resetLocation>;

beforeEach(async () => {
  // Whatever an earlier test left shared ends with its session, as a sign-out ends it.
  mockSignOut();
  mockSession.generation = 1;
  task = resetLocation("granted");
  jest.mocked(apiPut).mockReset().mockResolvedValue(undefined);
  now = NOW;
  jest.spyOn(Date, "now").mockImplementation(() => now);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("the location task", () => {
  it("is defined once, at import, under one name", () => {
    expect(jest.mocked(TaskManager.defineTask).mock.calls.map(([name]) => name)).toEqual([
      SHARING_TASK,
    ]);
  });

  it("starts every 10 s at balanced accuracy, moving or not, with the notification and the indicator", async () => {
    await shareJob(JOB_ID, 1);

    expect(Location.startLocationUpdatesAsync).toHaveBeenCalledTimes(1);
    expect(Location.startLocationUpdatesAsync).toHaveBeenCalledWith(SHARING_TASK, {
      accuracy: Location.Accuracy.Balanced,
      timeInterval: 10_000,
      distanceInterval: 0,
      showsBackgroundLocationIndicator: true,
      pausesUpdatesAutomatically: false,
      foregroundService: {
        notificationTitle: "Sharing your location",
        notificationBody: "Only while you're on the way. It stops when you check in.",
        notificationColor: tokens.colors["navy-900"],
        killServiceOnDestroy: true,
      },
    });
    // It reads the permission; it never asks for it.
    expect(Location.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
    expect(sharedJobId()).toBe(JOB_ID);
  });

  it("sends each fix with the job id, for the session that started it: the newest of a batch", async () => {
    await shareJob(JOB_ID, 1);
    await deliver([fix(NOW - 3 * SECOND, { latitude: 1, longitude: 2 }), fix(NOW - SECOND)]);

    expect(pings()).toEqual([
      [
        PING,
        {
          lat: LAT,
          lng: LNG,
          accuracy_m: 25,
          heading_deg: 90,
          recorded_at: new Date(NOW - SECOND).toISOString(),
        },
        { auth: true, generation: 1, params: { job_id: JOB_ID } },
      ],
    ]);
  });

  it.each([
    ["an unknown accuracy and heading (iOS reports -1)", { accuracy: null, heading: -1 }],
    ["an accuracy past the API's range", { accuracy: 20_000, heading: Number.NaN }],
  ])("leaves out %s", async (_case, coords) => {
    await shareJob(JOB_ID, 1);
    await deliver([fix(NOW, coords)]);

    expect(sent(0)).toEqual(expect.objectContaining({ accuracy_m: null, heading_deg: null }));
  });

  it("sends no sooner than the interval; a fix a little early still goes", async () => {
    await shareJob(JOB_ID, 1);
    await deliver([fix(NOW)]);
    at(5 * SECOND);
    await deliver([fix(NOW + 5 * SECOND)]);
    expect(pings()).toHaveLength(1);

    // The system's 10 s drift a little: 9.5 s later is the next ping, not the one after it.
    at(9.5 * SECOND);
    await deliver([fix(NOW + 9.5 * SECOND)]);
    expect(pings()).toHaveLength(2);
    at(12 * SECOND);
    await deliver([fix(NOW + 12 * SECOND)]);
    expect(pings()).toHaveLength(2);
  });

  it("never sends a second ping while one is on its way", async () => {
    const slow = deferred<undefined>();
    jest.mocked(apiPut).mockReturnValueOnce(slow.promise);
    await shareJob(JOB_ID, 1);
    const first = deliver([fix(NOW)]);
    at(20 * SECOND);
    await deliver([fix(NOW + 20 * SECOND)]);
    expect(pings()).toHaveLength(1);

    slow.resolve(undefined);
    await first;
    at(30 * SECOND);
    await deliver([fix(NOW + 30 * SECOND)]);
    expect(pings()).toHaveLength(2);
  });

  it.each([
    ["offline", new NetworkError(false, new Error("down"))],
    ["a timeout", new NetworkError(true, new Error("slow"))],
    ["too many pings (429)", new ApiError(429, "rate_limited")],
    ["positions unavailable (503)", new ApiError(503, "location_unavailable")],
    ["a fix the API found too old (422)", new ApiError(422, "validation_error")],
    ["an access token the client could not use (401)", new ApiError(401, "invalid_token")],
  ])(
    "drops a ping that failed (%s): no retry, no backlog, and sharing goes on",
    async (_c, error) => {
      jest.mocked(apiPut).mockRejectedValueOnce(error);
      await shareJob(JOB_ID, 1);
      await deliver([fix(NOW - SECOND, { latitude: 1 })]);
      expect(pings()).toHaveLength(1);

      // Nothing is sent again by itself, and a fix inside the interval is dropped too.
      at(5 * SECOND);
      await deliver([fix(NOW + 5 * SECOND, { latitude: 2 })]);
      expect(pings()).toHaveLength(1);

      // The next one carries the newest fix only: the failed one is gone.
      at(10 * SECOND);
      await deliver([fix(NOW + 10 * SECOND, { latitude: 3 })]);
      expect(pings()).toHaveLength(2);
      expect(sent(1)).toEqual(expect.objectContaining({ lat: 3 }));
      expect(task.running).toBe(true);
      expect(stops()).toBe(0);
    },
  );

  it.each([
    ["not on the way any more (409 not_on_the_way)", new ApiError(409, "not_on_the_way")],
    ["not this pro's job (403)", new ApiError(403, "forbidden")],
    ["a job that is gone (404)", new ApiError(404, "not_found")],
  ])("stops when the API refuses: %s, and never shares that job again", async (_c, error) => {
    jest.mocked(apiPut).mockRejectedValueOnce(error);
    await shareJob(JOB_ID, 1);
    await deliver([fix(NOW)]);

    expect(stops()).toBe(1);
    expect(task.running).toBe(false);
    expect(sharedJobId()).toBeNull();

    // The screen under a stale list asks again: nothing starts for that job.
    await shareJob(JOB_ID, 1);
    expect(starts()).toBe(1);
    at(10 * SECOND);
    await deliver([fix(NOW + 10 * SECOND)]);
    expect(pings()).toHaveLength(1);
  });

  it("stops at a sign-out on its own, before any fix comes, and a fix after it sends nothing", async () => {
    await shareJob(JOB_ID, 1);
    mockSignOut();

    await waitFor(() => expect(stops()).toBe(1));
    expect(task.running).toBe(false);
    await deliver([fix(NOW)]);
    expect(pings()).toHaveLength(0);
  });

  it("never sends for a session that is over, even before its stop has run", async () => {
    await shareJob(JOB_ID, 1);
    mockSession.generation = 2; // the session moved on; its sign-out work has not run yet

    await deliver([fix(NOW)]);
    expect(pings()).toHaveLength(0);
    expect(task.running).toBe(false);
  });

  it("a session the server ended during a ping stops sharing, and the next session can share the job", async () => {
    const answer = deferred<undefined>();
    jest.mocked(apiPut).mockReturnValueOnce(answer.promise);
    await shareJob(JOB_ID, 1);
    const ping = deliver([fix(NOW)]);
    mockSignOut(); // the refresh the ping needed was refused: the session ends under it
    answer.reject(new SessionExpiredError("expired"));
    await ping;
    await waitFor(() => expect(task.running).toBe(false));

    // Signed in again (the generation the sign-out moved to), the pro shares the job again.
    await shareJob(JOB_ID, 2);
    expect(task.running).toBe(true);
    expect(sharedJobId()).toBe(JOB_ID);
  });

  it("a refusal that lands after a sign-out leaves the job to the next session", async () => {
    const answer = deferred<undefined>();
    jest.mocked(apiPut).mockReturnValueOnce(answer.promise);
    await shareJob(JOB_ID, 1);
    const ping = deliver([fix(NOW)]);
    mockSignOut();
    answer.reject(new ApiError(409, "not_on_the_way"));
    await ping;

    await shareJob(JOB_ID, 2);
    expect(sharedJobId()).toBe(JOB_ID);
  });

  it("never starts a job the pro did not choose, whatever the permission allows", async () => {
    await startSharing(JOB_ID, 1);
    expect(starts()).toBe(0);
    expect(mayShare(JOB_ID)).toBe(false);

    await shareJob(JOB_ID, 1);
    expect(starts()).toBe(1);
    expect(mayShare(JOB_ID)).toBe(true);
  });

  it("with the phone's location off it starts nothing; switched on, the next start shares", async () => {
    task.on = false;
    await shareJob(JOB_ID, 1);
    expect(starts()).toBe(0);
    expect(sharedJobId()).toBeNull();

    task.on = true;
    await startSharing(JOB_ID, 1);
    expect(starts()).toBe(1);
  });

  it("forgets the pro's choices at a sign-out", async () => {
    await shareJob(JOB_ID, 1);
    mockSignOut();
    expect(mayShare(JOB_ID)).toBe(false);
  });

  it("a job that left the way while its start was under way does not start", async () => {
    resetLocation("granted");
    const permissionRead = deferred<ReturnType<typeof permission>>();
    jest.mocked(Location.getForegroundPermissionsAsync).mockReturnValueOnce(permissionRead.promise);
    const start = shareJob(JOB_ID, 1);
    await followJob(arrived()); // queued behind the start: the start re-checks first
    permissionRead.resolve(permission("granted"));
    await start;
    expect(starts()).toBe(0);
  });

  it("starts nothing for a session that is over", async () => {
    mockSession.generation = 2;
    await shareJob(JOB_ID, 1);
    expect(starts()).toBe(0);
    expect(mayShare(JOB_ID)).toBe(false);
  });

  it("stops a task the system restored on its own (a relaunch): nothing is shared in memory", async () => {
    task.running = true;
    await deliver([fix(NOW)]);

    expect(pings()).toHaveLength(0);
    expect(stops()).toBe(1);
  });

  it("starts one task for a job however often it is asked, and another job takes its place", async () => {
    await shareJob(JOB_ID, 1);
    await shareJob(JOB_ID, 1);
    await Promise.all([shareJob(JOB_ID, 1), shareJob(JOB_ID, 1)]);
    expect(starts()).toBe(1);

    await shareJob(OTHER_JOB, 1);
    expect(starts()).toBe(2);
    const names = jest.mocked(Location.startLocationUpdatesAsync).mock.calls.map(([name]) => name);
    expect(new Set(names)).toEqual(new Set([SHARING_TASK]));
    await deliver([fix(NOW)]);
    expect(pings()[0][2]).toEqual(expect.objectContaining({ params: { job_id: OTHER_JOB } }));
  });

  it("a refusal for the job shared before leaves the job shared now running", async () => {
    const answer = deferred<undefined>();
    jest.mocked(apiPut).mockReturnValueOnce(answer.promise);
    await shareJob(JOB_ID, 1);
    const ping = deliver([fix(NOW)]);
    // The pro goes on the way to another job while the first job's ping is out.
    await shareJob(OTHER_JOB, 1);

    answer.reject(new ApiError(409, "not_on_the_way"));
    await ping;
    expect(stops()).toBe(0);
    expect(task.running).toBe(true);
    expect(sharedJobId()).toBe(OTHER_JOB);
  });

  it("starts again for the same job when the system stopped the task", async () => {
    await shareJob(JOB_ID, 1);
    task.running = false;
    await shareJob(JOB_ID, 1);
    expect(starts()).toBe(2);
  });

  it("without the permission it starts nothing, and asks nothing", async () => {
    resetLocation("askable");
    await shareJob(JOB_ID, 1);
    resetLocation("blocked");
    await shareJob(JOB_ID, 1);

    expect(starts()).toBe(0);
    expect(Location.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
  });

  it("a start the system refuses leaves nothing shared, and the next one tries again", async () => {
    jest.mocked(Location.startLocationUpdatesAsync).mockRejectedValueOnce(new Error("background"));
    await shareJob(JOB_ID, 1);
    expect(sharedJobId()).toBeNull();

    await shareJob(JOB_ID, 1);
    expect(starts()).toBe(2);
    expect(sharedJobId()).toBe(JOB_ID);
  });

  it("an error from the system sends nothing and stops nothing", async () => {
    await shareJob(JOB_ID, 1);
    await deliver([fix(NOW)], { code: 0, message: "kCLErrorLocationUnknown" });

    expect(pings()).toHaveLength(0);
    expect(task.running).toBe(true);
  });
});

describe("followJob: the app saw the job as it is now", () => {
  const cancelled = proJob({ status: "cancelled" });
  it.each<[string, ProJob]>([
    ["checked in", arrived()],
    ["working", working()],
    ["cancelled", cancelled],
  ])("%s: sharing stops and the job is never shared again", async (_c, job) => {
    await shareJob(JOB_ID, 1);
    await followJob(job);

    expect(stops()).toBe(1);
    await shareJob(JOB_ID, 1);
    expect(starts()).toBe(1);
  });

  it.each<[string, ProJob]>([
    ["scheduled", proJob()],
    ["on the way", onTheWay()],
    ["locked", onTheWay({ arrival_code_locked: true })],
  ])("%s: sharing goes on", async (_c, job) => {
    await shareJob(JOB_ID, 1);
    await followJob(job);
    expect(stops()).toBe(0);
  });

  it("another job past the way leaves this one shared", async () => {
    await shareJob(JOB_ID, 1);
    await followJob(jobN(7, { status: "cancelled" }));
    expect(stops()).toBe(0);
  });
});

it("never writes a coordinate to the console, whatever happens", async () => {
  const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
    jest.spyOn(console, level),
  );
  const failures = [
    new NetworkError(false, new Error("down")),
    new ApiError(422, "validation_error"),
    new ApiError(409, "not_on_the_way"),
  ];
  await shareJob(JOB_ID, 1);
  for (const [index, failure] of failures.entries()) {
    jest.mocked(apiPut).mockRejectedValueOnce(failure);
    at(index * 10 * SECOND);
    await deliver([fix(now)]);
  }
  await deliver([fix(now)], { code: 1, message: "denied" });

  expect(pings()).toHaveLength(3);
  const written = consoleText(spies);
  expect(written).not.toContain(String(LAT));
  expect(written).not.toContain(String(LNG));
  expect(written).not.toContain("26.11");
});
