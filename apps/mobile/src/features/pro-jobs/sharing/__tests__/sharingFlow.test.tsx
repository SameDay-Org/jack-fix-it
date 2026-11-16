import "@/i18n";

import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import * as Location from "expo-location";
import { router } from "expo-router";
import { AppState, Linking, type AppStateStatus } from "react-native";

import { apiGet, apiPost, useSession } from "@/api";

import {
  arrived,
  JOB_ID,
  jobN,
  jobPage,
  navigation,
  newQueryClient,
  onTheWay,
  proJob,
  renderWithQuery,
  signedIn,
} from "../../__tests__/helpers";
import { deferred } from "../../../../api/__tests__/helpers";
import { checkIn, proJobQueryKey } from "../../api";
import { OnTheWaySheet } from "../../OnTheWaySheet";
import type { ProJob } from "../../phase";
import { ProJobScreen } from "../../ProJobScreen";
import { LocationSharing } from "../LocationSharing";
import { SHARING_TASK, sharedJobId, startSharing } from "../sender";

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
const SECOND_JOB = jobN(7, {
  status: "on_the_way",
  scheduled_start_at: proJob().scheduled_start_at,
});

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
  jest.mocked(AppState.addEventListener).mockClear();
  jest.mocked(Linking.openSettings).mockClear?.();
  Object.defineProperty(AppState, "currentState", { value: "active", configurable: true });
});

describe("On my way: the explanation before the system asks", () => {
  it("never asked: explains why, with whom, how often and when it stops, then Continue asks and shares", async () => {
    await goOnTheWay("askable");

    expect(await screen.findByTestId("share-location-sheet")).toBeTruthy();
    expect(screen.getByText("Share your location on the way")).toBeTruthy();
    expect(screen.getByTestId("share-location-body").props.children).toBe(
      "While you're on the way, Jack Fix It shares your location with Maria every 10 seconds, " +
        "so they can see you coming.",
    );
    expect(screen.getByTestId("share-location-stops").props.children).toBe(
      "It stops as soon as you check in, or if the job is cancelled. Your route isn't saved.",
    );
    expect(Location.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
    expect(starts()).toBe(0);
    expect(router.back).not.toHaveBeenCalled();

    await press("share-location-continue");
    expect(Location.requestForegroundPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(startedFor()).toEqual([SHARING_TASK]);
    expect(sharedJobId()).toBe(JOB_ID);
    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it("Not now: nothing is asked or shared, the sheet closes, and the job is on the way", async () => {
    await goOnTheWay("askable");
    await screen.findByTestId("share-location-sheet");

    await press("share-location-not-now");
    expect(Location.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
    expect(starts()).toBe(0);
    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it("Continue, then refused: nothing is shared and the sheet closes", async () => {
    await goOnTheWay("askable");
    await screen.findByTestId("share-location-sheet");
    jest
      .mocked(Location.requestForegroundPermissionsAsync)
      .mockResolvedValueOnce(permission("blocked"));

    await press("share-location-continue");
    expect(starts()).toBe(0);
    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it("two taps on Continue ask once", async () => {
    await goOnTheWay("askable");
    await screen.findByTestId("share-location-sheet");
    const answer = deferred<ReturnType<typeof permission>>();
    jest.mocked(Location.requestForegroundPermissionsAsync).mockReturnValueOnce(answer.promise);

    await press("share-location-continue");
    await press("share-location-continue");
    await act(async () => answer.resolve(permission("granted")));
    await waitFor(() => expect(router.back).toHaveBeenCalledTimes(1));
    expect(Location.requestForegroundPermissionsAsync).toHaveBeenCalledTimes(1);
  });

  it("already allowed: sharing starts with no explanation, and the sheet closes", async () => {
    await goOnTheWay("granted");

    await waitFor(() => expect(router.back).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("share-location-sheet")).toBeNull();
    expect(startedFor()).toEqual([SHARING_TASK]);
    expect(Location.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
  });

  it("refused for good: no explanation, nothing asked or shared, and the sheet closes", async () => {
    await goOnTheWay("blocked");

    await waitFor(() => expect(router.back).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("share-location-sheet")).toBeNull();
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
    expect(screen.queryByTestId("share-location-sheet")).toBeNull();
    expect(Location.getForegroundPermissionsAsync).not.toHaveBeenCalled();
  });
});

describe("the job screen on the way", () => {
  /** Renders the screen and waits for the job's title (the API answered). */
  async function open(job: ProJob, access: Access) {
    resetLocation(access);
    jest.mocked(apiGet).mockResolvedValue(job);
    const view = await renderWithQuery(<ProJobScreen />);
    await screen.findByTestId("pro-job-title");
    return view;
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
    expect(screen.getByTestId("pro-job-arrived")).toBeTruthy();
  });

  it.each<[string, ProJob, Access]>([
    ["allowed", onTheWay(), "granted"],
    ["not on the way yet", proJob(), "askable"],
    ["checked in", arrived(), "askable"],
  ])("%s: no line", async (_c, job, access) => {
    await open(job, access);
    expect(screen.queryByTestId("pro-job-sharing-note")).toBeNull();
  });

  it("a locked check-in is still on the way: the line stays", async () => {
    await open(onTheWay({ arrival_code_locked: true }), "askable");
    expect(await screen.findByTestId("pro-job-sharing-note")).toBeTruthy();
  });

  it("a refetch that finds the job cancelled ends its sharing", async () => {
    await startSharing(JOB_ID, 1);
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

  it("shares the job on the way, once however often it mounts", async () => {
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

  it("stops once the list shows the job checked in, and starts nothing for it again", async () => {
    answer(onTheWay());
    const client = newQueryClient();
    await renderWithQuery(<LocationSharing />, client);
    await waitFor(() => expect(starts()).toBe(1));

    answer(arrived());
    await act(async () => {
      await client.refetchQueries();
    });
    await waitFor(() => expect(stops()).toBe(1));
    expect(starts()).toBe(1);
  });

  it("stops once the job is gone from the active list (cancelled)", async () => {
    answer(onTheWay());
    const client = newQueryClient();
    await renderWithQuery(<LocationSharing />, client);
    await waitFor(() => expect(starts()).toBe(1));

    answer();
    await act(async () => {
      await client.refetchQueries();
    });
    await waitFor(() => expect(stops()).toBe(1));
  });

  it("two jobs on the way: one task, for the soonest, and the one the pro chose stays", async () => {
    answer(onTheWay(), SECOND_JOB);
    const client = newQueryClient();
    await renderWithQuery(<LocationSharing />, client);
    await waitFor(() => expect(starts()).toBe(1));
    const soonest = sharedJobId();
    expect([JOB_ID, SECOND_JOB.id]).toContain(soonest);

    const other = soonest === JOB_ID ? SECOND_JOB.id : JOB_ID;
    await startSharing(other, 1);
    await act(async () => {
      await client.refetchQueries();
    });
    expect(sharedJobId()).toBe(other);
    expect(new Set(startedFor())).toEqual(new Set([SHARING_TASK]));
  });

  it("in the background it starts nothing; back in front, it shares", async () => {
    Object.defineProperty(AppState, "currentState", { value: "background", configurable: true });
    answer(onTheWay());
    await renderWithQuery(<LocationSharing />);
    await act(async () => undefined);
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    expect(starts()).toBe(0);

    await act(async () => appMoves("active"));
    await waitFor(() => expect(starts()).toBe(1));
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
    await startSharing(JOB_ID, 1);
    jest.mocked(apiGet).mockRejectedValue(new Error("offline"));
    await renderWithQuery(<LocationSharing />);
    await act(async () => undefined);
    expect(stops()).toBe(0);
  });
});

it("a check-in answered by the API ends the job's sharing at once", async () => {
  await startSharing(JOB_ID, 1);
  jest.mocked(apiPost).mockResolvedValueOnce(arrived());

  await checkIn(newQueryClient(), JOB_ID, "4821", { lat: 1, lng: 2 }, 1);
  await waitFor(() => expect(stops()).toBe(1));
  expect(sharedJobId()).toBeNull();
});
