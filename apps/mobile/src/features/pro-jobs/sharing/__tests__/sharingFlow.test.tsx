import "@/i18n";

import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import * as Location from "expo-location";
import { router } from "expo-router";
import { AppState, Linking, Platform, type AppStateStatus } from "react-native";

import { apiGet, apiPost, useSession } from "@/api";

import {
  arrived,
  hoursFromNow,
  JOB_ID,
  jobN,
  jobPage,
  navigation,
  newQueryClient,
  onTheWay,
  proJob,
  renderWithQuery,
  signedIn,
  working,
} from "../../__tests__/helpers";
import { deferred } from "../../../../api/__tests__/helpers";
import { checkIn, completeJob, markOnTheWay, proJobQueryKey, proJobsQueryKey } from "../../api";
import { OnTheWaySheet } from "../../OnTheWaySheet";
import type { ProJob } from "../../phase";
import { ProJobScreen } from "../../ProJobScreen";
import { LocationSharing } from "../LocationSharing";
import { ShareLocationScreen } from "../ShareLocationScreen";
import { followJob, mayShare, shareJob, SHARING_TASK, sharedJobId, startSharing } from "../sender";

import { permission, resetLocation, starts, stops, type Access } from "./helpers";

jest.mock("@/api", () => ({
  ...jest.requireActual("../../__tests__/helpers").apiMock(),
  apiPut: jest.fn(),
}));
jest.mock("expo-router", () => jest.requireActual("../../__tests__/helpers").routerMock);
jest.mock("expo-haptics");
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));
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
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);
// Reduce Motion on: the loading skeleton's endless pulse would otherwise keep the run busy.
jest.mock("react-native-reanimated", () => ({
  __esModule: true,
  ...jest.requireActual<typeof import("react-native-reanimated")>("react-native-reanimated"),
  useReducedMotion: jest.fn(() => true),
}));

const { mockSession, mockSignOut } = jest.requireMock<{
  mockSession: { generation: number };
  mockSignOut: () => void;
}>("@/api");

const ON_THE_WAY = "/v1/pros/me/jobs/{job_id}/on-the-way";
const LIST = "/v1/pros/me/jobs";
/** On the way too, two hours after the first job. */
const SECOND_JOB = jobN(7, { status: "on_the_way", scheduled_start_at: hoursFromNow(5) });

const press = async (testID: string) => {
  await act(async () => {
    await fireEvent.press(screen.getByTestId(testID));
  });
};
const startedFor = () =>
  jest.mocked(Location.startLocationUpdatesAsync).mock.calls.map(([name]) => name);

/** Tells the AppState listeners still subscribed that the app moved to `state`. */
function appMoves(state: AppStateStatus): void {
  Object.defineProperty(AppState, "currentState", { value: state, configurable: true });
  const { calls, results } = jest.mocked(AppState.addEventListener).mock;
  calls.forEach(([type, listener], index) => {
    const subscription = results[index]?.value as { remove: jest.Mock } | undefined;
    if (type !== "change" || subscription?.remove.mock.calls.length) return;
    (listener as (next: AppStateStatus) => void)(state);
  });
}

/** Opens "On my way" over a scheduled job, picks 20 min and sends; the API answers on the way. */
async function goOnTheWay(access: Access, job: ProJob = proJob()) {
  resetLocation(access);
  const client = newQueryClient();
  client.setQueryData(proJobQueryKey(JOB_ID, 1), job);
  jest.mocked(apiPost).mockResolvedValueOnce(onTheWay());
  await renderWithQuery(<OnTheWaySheet />, client);
  await press("on-the-way-preset-20");
  await press("on-the-way-send");
  expect(apiPost).toHaveBeenCalledWith(ON_THE_WAY, { eta_minutes: 20 }, expect.anything());
}

beforeEach(() => {
  mockSignOut(); // what an earlier test shared ends with its session
  mockSession.generation = 1;
  resetLocation("granted");
  navigation.reset();
  navigation.setParams({ id: JOB_ID });
  jest.mocked(useSession).mockReturnValue(signedIn({ role: "pro" }));
  jest.mocked(apiGet).mockReset();
  jest.mocked(apiPost).mockReset();
  jest.mocked(router.back).mockClear();
  jest.mocked(router.replace).mockClear();
  jest.mocked(AppState.addEventListener).mockClear();
  jest.mocked(Linking.openSettings).mockClear?.();
  Object.defineProperty(AppState, "currentState", { value: "active", configurable: true });
});

afterEach(() => {
  jest.restoreAllMocks(); // a test that stood for Android
});

/** The pro chose to share `jobIds` before the permission was given: nothing started yet. */
async function chooseBeforeGrant(...jobIds: string[]) {
  const task = resetLocation("askable");
  for (const id of jobIds) await shareJob(id, 1);
  expect(starts()).toBe(0);
  task.access = "granted";
  jest.mocked(Location.getForegroundPermissionsAsync).mockClear();
  return task;
}

describe("On my way hands over to the explanation", () => {
  const EXPLANATION = { pathname: "/jobs/[id]/share-location", params: { id: JOB_ID } };

  it.each<Access>(["askable", "granted"])(
    "%s: the sheet becomes the explanation, and nothing is asked or shared yet",
    async (access) => {
      await goOnTheWay(access);

      await waitFor(() => expect(router.replace).toHaveBeenCalledWith(EXPLANATION));
      expect(router.back).not.toHaveBeenCalled();
      expect(Location.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
      expect(starts()).toBe(0);
    },
  );

  it("refused for good: no explanation, nothing asked or shared, and the sheet closes", async () => {
    await goOnTheWay("blocked");

    await waitFor(() => expect(router.back).toHaveBeenCalledTimes(1));
    expect(router.replace).not.toHaveBeenCalled();
    expect(Location.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
    expect(starts()).toBe(0);
  });

  it("an arrival time update asks nothing", async () => {
    resetLocation("askable");
    const client = newQueryClient();
    client.setQueryData(proJobQueryKey(JOB_ID, 1), onTheWay());
    jest.mocked(apiPost).mockResolvedValueOnce(onTheWay());
    await renderWithQuery(<OnTheWaySheet />, client);
    await press("on-the-way-preset-30");
    await press("on-the-way-send");

    await waitFor(() => expect(router.back).toHaveBeenCalledTimes(1));
    expect(router.replace).not.toHaveBeenCalled();
    expect(Location.getForegroundPermissionsAsync).not.toHaveBeenCalled();
  });
});

describe("the explanation (/jobs/[id]/share-location)", () => {
  /** The explanation over its job, as the job screen under it holds it in the cache. */
  async function explain(access: Access, job: ProJob = onTheWay()) {
    const task = resetLocation(access);
    const client = newQueryClient();
    client.setQueryData(proJobQueryKey(JOB_ID, 1), job);
    await renderWithQuery(<ShareLocationScreen />, client);
    return task;
  }

  it("says why, with whom, how often and when it stops; Continue asks and shares", async () => {
    await explain("askable");

    expect(screen.getByText("Share your location on the way")).toBeTruthy();
    expect(screen.getByTestId("share-location-body").props.children).toBe(
      "While you're on the way, Jack Fix It shares your location with Maria every 10 seconds, " +
        "so they can see you coming.",
    );
    expect(screen.getByTestId("share-location-stops").props.children).toBe(
      "It stops as soon as you check in, or if the job is cancelled. Jack Fix It doesn't keep " +
        "a history of where you've been.",
    );
    expect(screen.getByTestId("share-location-continue").props.accessibilityLabel).toBe("Continue");
    expect(screen.getByTestId("share-location-not-now").props.accessibilityLabel).toBe("Not now");
    expect(starts()).toBe(0);

    await press("share-location-continue");
    expect(Location.requestForegroundPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(startedFor()).toEqual([SHARING_TASK]);
    expect(sharedJobId()).toBe(JOB_ID);
    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it("already allowed (for check-in): only Continue shares", async () => {
    await explain("granted");
    expect(starts()).toBe(0);

    await press("share-location-continue");
    expect(startedFor()).toEqual([SHARING_TASK]);
    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it.each<Access>(["askable", "granted"])(
    "Not now (%s): nothing is asked or shared, and the job screen is next",
    async (access) => {
      await explain(access);

      await press("share-location-not-now");
      expect(Location.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
      expect(starts()).toBe(0);
      expect(mayShare(JOB_ID)).toBe(false);
      expect(router.back).toHaveBeenCalledTimes(1);
    },
  );

  it("Continue, then refused at the system's prompt: a Not now; a grant made later for check-in shares nothing", async () => {
    await explain("askable");
    jest
      .mocked(Location.requestForegroundPermissionsAsync)
      .mockResolvedValueOnce(permission("askable"));

    await press("share-location-continue");
    expect(starts()).toBe(0);
    expect(mayShare(JOB_ID)).toBe(false);
    expect(router.back).toHaveBeenCalledTimes(1);

    // Check-in asks for the same permission and gets it: still nothing is shared.
    jest.mocked(Location.getForegroundPermissionsAsync).mockResolvedValue(permission("granted"));
    await startSharing(JOB_ID, 1);
    expect(starts()).toBe(0);
  });

  it("Android with the location off: Continue offers to switch it on, then shares", async () => {
    jest.replaceProperty(Platform, "OS", "android");
    const task = await explain("granted");
    task.on = false;

    await press("share-location-continue");
    expect(Location.enableNetworkProviderAsync).toHaveBeenCalledTimes(1);
    expect(starts()).toBe(1);
    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it("left while the system answered: no second back", async () => {
    await explain("askable");
    const answer = deferred<ReturnType<typeof permission>>();
    jest.mocked(Location.requestForegroundPermissionsAsync).mockReturnValueOnce(answer.promise);

    await press("share-location-continue");
    await screen.unmount(); // the pro went back meanwhile
    await act(async () => answer.resolve(permission("granted")));
    expect(router.back).not.toHaveBeenCalled();
  });

  it("two taps on Continue ask once", async () => {
    await explain("askable");
    const answer = deferred<ReturnType<typeof permission>>();
    jest.mocked(Location.requestForegroundPermissionsAsync).mockReturnValueOnce(answer.promise);

    await press("share-location-continue");
    await press("share-location-continue");
    await act(async () => answer.resolve(permission("granted")));
    await waitFor(() => expect(router.back).toHaveBeenCalledTimes(1));
    expect(Location.requestForegroundPermissionsAsync).toHaveBeenCalledTimes(1);
  });

  it("a job no longer on the way (checked in elsewhere) leaves at once, asking nothing", async () => {
    await explain("askable", arrived());

    await waitFor(() => expect(router.back).toHaveBeenCalledTimes(1));
    expect(Location.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
  });
});

describe("the job screen on the way", () => {
  /** Renders the screen and waits for the job's title (the API answered). */
  async function open(job: ProJob, access: Access) {
    const task = resetLocation(access);
    jest.mocked(apiGet).mockResolvedValue(job);
    await renderWithQuery(<ProJobScreen />);
    await screen.findByTestId("pro-job-title");
    return task;
  }

  it("never asked: one calm line and Share location, which asks and starts sharing", async () => {
    await open(onTheWay(), "askable");

    const note = await screen.findByTestId("pro-job-sharing-note-message");
    expect(note.props.children).toBe("Your location isn't shared with Maria on the way.");
    expect(screen.getByTestId("pro-job-sharing-note-action").props.accessibilityLabel).toBe(
      "Share location",
    );
    // The job flow is all there: I've arrived and the arrival time.
    expect(screen.getByTestId("pro-job-arrived")).toBeTruthy();

    await press("pro-job-sharing-note-action");
    expect(Location.requestForegroundPermissionsAsync).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(startedFor()).toEqual([SHARING_TASK]));
    await waitFor(() => expect(screen.queryByTestId("pro-job-sharing-note")).toBeNull());
  });

  it("allowed but not chosen (Not now, or a relaunch): the line shows, and Share location shares", async () => {
    await open(onTheWay(), "granted");

    expect(await screen.findByTestId("pro-job-sharing-note")).toBeTruthy();
    expect(starts()).toBe(0);
    await press("pro-job-sharing-note-action");
    await waitFor(() => expect(startedFor()).toEqual([SHARING_TASK]));
    await waitFor(() => expect(screen.queryByTestId("pro-job-sharing-note")).toBeNull());
  });

  it("Android with the location off: Share location offers to switch it on, then shares", async () => {
    jest.replaceProperty(Platform, "OS", "android");
    const task = await open(onTheWay(), "granted");
    task.on = false;

    await press("pro-job-sharing-note-action");
    expect(Location.enableNetworkProviderAsync).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(starts()).toBe(1));
  });

  it("a job the API refused has no line: nothing could share it", async () => {
    await open(onTheWay(), "askable");
    expect(await screen.findByTestId("pro-job-sharing-note")).toBeTruthy();

    // Cancelled or checked in elsewhere: the app hears it before the screen reads the job again.
    await act(() => followJob(proJob({ status: "cancelled" })));
    await waitFor(() => expect(screen.queryByTestId("pro-job-sharing-note")).toBeNull());
  });

  it("refused for good: the line opens the settings, and nothing is asked", async () => {
    await open(onTheWay(), "blocked");

    await screen.findByTestId("pro-job-sharing-note");
    expect(screen.getByTestId("pro-job-sharing-note-action").props.accessibilityLabel).toBe(
      "Open Settings",
    );
    await press("pro-job-sharing-note-action");
    expect(Linking.openSettings).toHaveBeenCalledTimes(1);
    expect(Location.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
    expect(mayShare(JOB_ID)).toBe(true);
    expect(screen.getByTestId("pro-job-arrived")).toBeTruthy();
  });

  it.each<[string, ProJob]>([
    ["not on the way yet", proJob()],
    ["checked in", arrived()],
  ])("%s: no line", async (_c, job) => {
    await open(job, "askable");
    expect(screen.queryByTestId("pro-job-sharing-note")).toBeNull();
  });

  it("a locked check-in is still on the way: the line stays", async () => {
    await open(onTheWay({ arrival_code_locked: true }), "askable");
    expect(await screen.findByTestId("pro-job-sharing-note")).toBeTruthy();
  });

  it("a refetch that finds the job cancelled ends its sharing", async () => {
    await shareJob(JOB_ID, 1);
    jest.mocked(apiGet).mockResolvedValue(proJob({ status: "cancelled" }));
    await renderWithQuery(<ProJobScreen />);
    await screen.findByTestId("pro-job-title");
    await waitFor(() => expect(stops()).toBe(1));
    expect(sharedJobId()).toBeNull();
  });
});

describe("LocationSharing: in step with the pro's jobs", () => {
  const answer = (...jobs: ProJob[]) =>
    jest.mocked(apiGet).mockImplementation(async (path) => {
      if (path !== LIST) throw new Error(`unexpected ${String(path)}`);
      return jobPage(jobs);
    });
  /** Waits for the list, then long enough for a start the effect queued to reach the system. */
  const listIn = async (client: ReturnType<typeof newQueryClient>) => {
    await waitFor(() => expect(client.getQueryState(proJobsQueryKey(1))?.status).toBe("success"));
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
  };

  it("shares a job on the way the pro chose, once however often it mounts", async () => {
    await chooseBeforeGrant(JOB_ID);
    answer(proJob({ id: jobN(3).id }), onTheWay());
    const client = newQueryClient();
    const first = await renderWithQuery(<LocationSharing />, client);
    await waitFor(() => expect(startedFor()).toEqual([SHARING_TASK]));
    expect(sharedJobId()).toBe(JOB_ID);

    await first.unmount();
    await renderWithQuery(<LocationSharing />, client);
    await act(async () => undefined);
    expect(starts()).toBe(1);
  });

  it("never shares a job the pro did not choose (Not now, or a relaunch)", async () => {
    answer(onTheWay());
    const client = newQueryClient();
    await renderWithQuery(<LocationSharing />, client);
    await listIn(client);
    expect(starts()).toBe(0);
  });

  it("stops once the list shows the job checked in, and starts nothing for it again", async () => {
    await shareJob(JOB_ID, 1);
    answer(onTheWay());
    const client = newQueryClient();
    await renderWithQuery(<LocationSharing />, client);
    await listIn(client);

    answer(arrived());
    await act(async () => {
      await client.refetchQueries();
    });
    await waitFor(() => expect(stops()).toBe(1));
    expect(starts()).toBe(1);
  });

  it("stops once the job is gone from the active list (cancelled)", async () => {
    await shareJob(JOB_ID, 1);
    answer(onTheWay());
    const client = newQueryClient();
    await renderWithQuery(<LocationSharing />, client);
    await listIn(client);

    answer();
    await act(async () => {
      await client.refetchQueries();
    });
    await waitFor(() => expect(stops()).toBe(1));
  });

  it("two jobs on the way, both chosen: one task, for the soonest; the one shared next stays", async () => {
    await chooseBeforeGrant(SECOND_JOB.id, JOB_ID);
    answer(onTheWay(), SECOND_JOB);
    const client = newQueryClient();
    await renderWithQuery(<LocationSharing />, client);
    await waitFor(() => expect(starts()).toBe(1));
    expect(sharedJobId()).toBe(JOB_ID);

    await shareJob(SECOND_JOB.id, 1);
    await act(async () => {
      await client.refetchQueries();
    });
    expect(sharedJobId()).toBe(SECOND_JOB.id);
    expect(new Set(startedFor())).toEqual(new Set([SHARING_TASK]));
  });

  it("skips a job that left the way while the list still shows it: the next one is shared", async () => {
    await chooseBeforeGrant(JOB_ID, SECOND_JOB.id);
    await followJob(arrived());
    answer(onTheWay(), SECOND_JOB);
    const client = newQueryClient();
    await renderWithQuery(<LocationSharing />, client);
    await waitFor(() => expect(starts()).toBe(1));
    expect(sharedJobId()).toBe(SECOND_JOB.id);
  });

  it("stops a shared job the list no longer has on the way, whatever else is on the way", async () => {
    await shareJob(JOB_ID, 1);
    answer(onTheWay());
    const client = newQueryClient();
    await renderWithQuery(<LocationSharing />, client);
    await listIn(client);

    // The job was cancelled; another one, never chosen, is on the way.
    answer(SECOND_JOB);
    await act(async () => {
      await client.refetchQueries();
    });
    await waitFor(() => expect(stops()).toBe(1));
    expect(sharedJobId()).toBeNull();
  });

  it("in the background, a shared job that is not the one to share stops; the next starts in front", async () => {
    await chooseBeforeGrant(SECOND_JOB.id);
    await shareJob(JOB_ID, 1);
    answer(onTheWay(), SECOND_JOB);
    const client = newQueryClient();
    await renderWithQuery(<LocationSharing />, client);
    await listIn(client);
    expect(sharedJobId()).toBe(JOB_ID);

    Object.defineProperty(AppState, "currentState", { value: "background", configurable: true });
    await act(async () => appMoves("background"));
    answer(SECOND_JOB, proJob({ id: JOB_ID, status: "cancelled" }));
    await act(async () => {
      await client.refetchQueries();
    });
    await waitFor(() => expect(stops()).toBe(1));
    const before = starts();

    await act(async () => appMoves("active"));
    await waitFor(() => expect(starts()).toBe(before + 1));
    expect(sharedJobId()).toBe(SECOND_JOB.id);
  });

  it("the list holds On my way's answer even when it did not have the job yet", async () => {
    const client = newQueryClient();
    const held = deferred<ReturnType<typeof jobPage>>();
    let lists = 0;
    jest.mocked(apiGet).mockImplementation(async (path) => {
      if (path !== LIST) throw new Error(`unexpected ${String(path)}`);
      lists += 1;
      return lists === 1 ? jobPage([]) : held.promise;
    });
    await renderWithQuery(<LocationSharing />, client);
    await listIn(client);

    jest.mocked(apiPost).mockResolvedValueOnce(onTheWay());
    await act(async () => {
      await markOnTheWay(client, JOB_ID, 20, 1);
    });
    expect(client.getQueryData<ProJob[]>(proJobsQueryKey(1))?.map(({ id }) => id)).toEqual([
      JOB_ID,
    ]);
    await shareJob(JOB_ID, 1);
    await act(async () => appMoves("background"));
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(stops()).toBe(0);
  });

  it("the list drops a job the answer says is done", async () => {
    const client = newQueryClient();
    client.setQueryData(proJobsQueryKey(1), [working()]);
    jest.mocked(apiPost).mockResolvedValueOnce(working({ status: "completed" }));

    await completeJob(client, JOB_ID, 1);
    expect(client.getQueryData(proJobsQueryKey(1))).toEqual([]);
  });

  it("in the background it starts nothing; back in front, it shares", async () => {
    await chooseBeforeGrant(JOB_ID);
    Object.defineProperty(AppState, "currentState", { value: "background", configurable: true });
    answer(onTheWay());
    const client = newQueryClient();
    await renderWithQuery(<LocationSharing />, client);
    await listIn(client);
    expect(Location.getForegroundPermissionsAsync).not.toHaveBeenCalled();
    expect(starts()).toBe(0);

    await act(async () => appMoves("active"));
    await waitFor(() => expect(starts()).toBe(1));
  });

  it("locking the phone right after On my way keeps sharing, before the list is in again", async () => {
    const client = newQueryClient();
    const held = deferred<ReturnType<typeof jobPage>>();
    let lists = 0;
    jest.mocked(apiGet).mockImplementation(async (path) => {
      if (path !== LIST) throw new Error(`unexpected ${String(path)}`);
      lists += 1;
      return lists === 1 ? jobPage([proJob()]) : held.promise;
    });
    await renderWithQuery(<LocationSharing />, client);
    await listIn(client);

    // On my way is answered, the list is asked for again (held), and the pro shares.
    jest.mocked(apiPost).mockResolvedValueOnce(onTheWay());
    await act(async () => {
      await markOnTheWay(client, JOB_ID, 20, 1);
    });
    await shareJob(JOB_ID, 1);
    expect(starts()).toBe(1);

    // The pro locks the phone while the list is still being asked for again.
    await act(async () => appMoves("background"));
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(stops()).toBe(0);
    await act(async () => held.resolve(jobPage([onTheWay()])));
    expect(stops()).toBe(0);
    expect(sharedJobId()).toBe(JOB_ID);
  });

  it("asks nothing and shares nothing for a customer", async () => {
    jest.mocked(useSession).mockReturnValue(signedIn({ role: "customer" }));
    await renderWithQuery(<LocationSharing />);
    await act(async () => undefined);
    expect(apiGet).not.toHaveBeenCalled();
    expect(starts()).toBe(0);
    expect(stops()).toBe(0);
  });

  it("a list that failed changes nothing", async () => {
    await shareJob(JOB_ID, 1);
    jest.mocked(apiGet).mockRejectedValue(new Error("offline"));
    await renderWithQuery(<LocationSharing />);
    await act(async () => undefined);
    expect(stops()).toBe(0);
  });
});

it("a check-in answered by the API ends the job's sharing at once", async () => {
  await shareJob(JOB_ID, 1);
  jest.mocked(apiPost).mockResolvedValueOnce(arrived());

  await checkIn(newQueryClient(), JOB_ID, "4821", { lat: 1, lng: 2 }, 1);
  await waitFor(() => expect(stops()).toBe(1));
  expect(sharedJobId()).toBeNull();
});
