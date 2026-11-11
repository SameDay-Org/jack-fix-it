import "@/i18n";

import { act, fireEvent, screen } from "@testing-library/react-native";
import * as Haptics from "expo-haptics";
import { AccessibilityInfo, AppState, type AppStateStatus } from "react-native";

import { ApiError, apiGet, apiPost, useSession } from "@/api";
import { dismissToast, toastStore } from "@/components/ui/toast";

import { deferred } from "../../../api/__tests__/helpers";
import { proJobsConfig } from "../config";
import type { JobPhoto, ProJob } from "../phase";
import { ProJobScreen } from "../ProJobScreen";
import {
  fakeClock,
  freezeClock,
  hoursFromNow,
  JOB_ID,
  minutesFromNow,
  navigation,
  NO_PHOTO_COUNTS,
  renderWithQuery,
  signedIn,
  working,
} from "./helpers";

jest.mock("@/api", () => jest.requireActual("./helpers").apiMock());
jest.mock("expo-router", () => jest.requireActual("./helpers").routerMock);
// Root manual mock (apps/mobile/__mocks__): named here so the test and the screen share one instance.
jest.mock("expo-haptics");
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));
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

const { mockSession } = jest.requireMock<{ mockSession: { generation: number } }>("@/api");

const COMPLETE = "/v1/pros/me/jobs/{job_id}/complete";
const PROCESSING = "Finishing your photos…";
const SLOW = "Your photos are taking longer than usual. Try again in a moment.";
const PHOTOS_FAILED = "We couldn't prepare your after photos. Add another one.";
const INTERVAL = proJobsConfig.doneRetryIntervalMs;
const WAITING = "Job's done. Waiting for Maria to confirm.";

const photo = (n: number): JobPhoto => ({
  id: `00000000-0000-4000-8000-0000000007${String(n).padStart(2, "0")}`,
  content_type: "image/jpeg",
  url: `https://photos.test.invalid/jobs/after-${n}.jpg?X-Amz-Signature=sig-${n}`,
  expires_at: hoursFromNow(1),
});

/** Working, with `count` after photos on the job. */
const withAfter = (count: number, overrides: Partial<ProJob> = {}): ProJob =>
  working({
    photos: {
      before: [],
      after: Array.from({ length: count }, (_, i) => photo(i + 1)),
      ...NO_PHOTO_COUNTS,
    },
    ...overrides,
  });

const completed = (): ProJob =>
  withAfter(1, { status: "completed", completed_at: minutesFromNow(0) });
const processing = () => new ApiError(409, "after_photos_processing");
const photosRequired = () => new ApiError(409, "after_photos_required");

const completeCalls = () =>
  jest.mocked(apiPost).mock.calls.filter(([path]) => path === COMPLETE).length;
const announced = () =>
  jest.mocked(AccessibilityInfo.announceForAccessibilityWithOptions).mock.calls.map(([m]) => m);
const advance = (ms: number) =>
  act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
const tapDone = () => act(async () => fireEvent.press(screen.getByTestId("pro-job-done")));
const setFocused = (focused: boolean) => act(async () => navigation.setFocused(focused));

/** The app goes to the background or comes back, as AppState tells its listeners. */
const ORIGINAL_STATE = Object.getOwnPropertyDescriptor(AppState, "currentState");
async function moveApp(state: AppStateStatus): Promise<void> {
  await act(async () => {
    Object.defineProperty(AppState, "currentState", { value: state, configurable: true });
    const { calls, results } = jest.mocked(AppState.addEventListener).mock;
    calls.forEach(([type, listener], index) => {
      const subscription = results[index]?.value as { remove: jest.Mock } | undefined;
      if (type !== "change" || subscription?.remove.mock.calls.length) return;
      (listener as (next: AppStateStatus) => void)(state);
    });
  });
}

async function open(job: ProJob) {
  jest.mocked(apiGet).mockResolvedValue(job);
  await renderWithQuery(<ProJobScreen />);
  await screen.findByTestId("pro-job-title");
}

let announceSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  freezeClock();
  navigation.reset();
  navigation.setParams({ id: JOB_ID });
  mockSession.generation = 1;
  jest.mocked(useSession).mockReturnValue(signedIn({ role: "pro" }));
  jest.mocked(apiGet).mockReset();
  jest.mocked(apiPost).mockReset();
  announceSpy = jest
    .spyOn(AccessibilityInfo, "announceForAccessibilityWithOptions")
    .mockImplementation(() => undefined);
  toastStore.setState({ current: null });
});

afterEach(() => {
  announceSpy.mockRestore();
  dismissToast();
  jest.useRealTimers();
  if (ORIGINAL_STATE) Object.defineProperty(AppState, "currentState", ORIGINAL_STATE);
});

describe("Job's done belongs to the screen in front (#63 B round 1, B2)", () => {
  it("a blur while it waits for the copies stops every later POST and says nothing", async () => {
    fakeClock();
    jest.mocked(apiPost).mockRejectedValue(processing());
    await open(withAfter(1));
    await tapDone();
    expect(completeCalls()).toBe(1);

    await setFocused(false);
    await advance(proJobsConfig.doneRetryWindowMs * 2);
    expect(completeCalls()).toBe(1);
    expect(announced()).not.toContain(SLOW);
    expect(Haptics.notificationAsync).not.toHaveBeenCalled();
  });

  it("the app going to the background stops it too; the foreground starts one fresh run", async () => {
    fakeClock();
    jest.mocked(apiPost).mockRejectedValue(processing());
    await open(withAfter(1));
    await tapDone();

    await moveApp("background");
    await advance(proJobsConfig.doneRetryWindowMs);
    expect(completeCalls()).toBe(1);

    jest.mocked(apiPost).mockResolvedValue(completed());
    await moveApp("active");
    await advance(0);
    expect(completeCalls()).toBe(2);
    expect(Haptics.notificationAsync).toHaveBeenCalledTimes(1);
  });

  it("a quick blur and refocus: the old run never picks up, one fresh run asks on its own clock", async () => {
    fakeClock();
    jest.mocked(apiPost).mockRejectedValue(processing());
    await open(withAfter(1));
    await tapDone();
    await advance(INTERVAL / 2);

    await setFocused(false);
    await setFocused(true);
    await advance(0);
    // One fresh POST on return, not two runs interleaving.
    expect(completeCalls()).toBe(2);
    await advance(INTERVAL / 2);
    expect(completeCalls()).toBe(2);
    await advance(INTERVAL / 2);
    expect(completeCalls()).toBe(3);
  });

  it("a blur while the POST is in flight: its answer is not announced; back in front, one fresh POST", async () => {
    fakeClock();
    const held = deferred<ProJob>();
    jest.mocked(apiPost).mockReturnValueOnce(held.promise as ReturnType<typeof apiPost>);
    await open(withAfter(1));
    await tapDone();

    await setFocused(false);
    await act(async () => held.reject(processing()));
    await advance(INTERVAL * 3);
    expect(completeCalls()).toBe(1);
    expect(announced()).not.toContain(PROCESSING);

    jest.mocked(apiPost).mockRejectedValue(processing());
    await setFocused(true);
    await advance(0);
    expect(completeCalls()).toBe(2);
    expect(announced()).toContain(PROCESSING);
  });

  it("a run that ended on its own does not start again on return", async () => {
    jest.mocked(apiPost).mockRejectedValue(photosRequired());
    await open(withAfter(1));
    await tapDone();
    expect(announced()).toContain(PHOTOS_FAILED);

    await setFocused(false);
    await setFocused(true);
    await act(async () => undefined);
    expect(completeCalls()).toBe(1);
  });
});

describe("Job's done answered away from the screen (#63 B round 2, B2)", () => {
  it("a success landing in the background is silent there and said once on return", async () => {
    fakeClock();
    const held = deferred<ProJob>();
    jest.mocked(apiPost).mockReturnValueOnce(held.promise as ReturnType<typeof apiPost>);
    await open(withAfter(1));
    await tapDone();

    await moveApp("background");
    const before = announced();
    // The server finished the job: the cache follows the answer (the refetch on return agrees).
    jest.mocked(apiGet).mockResolvedValue(completed());
    await act(async () => held.resolve(completed()));
    await advance(INTERVAL * 3);
    expect(announced()).toEqual(before);
    expect(Haptics.notificationAsync).not.toHaveBeenCalled();
    expect(completeCalls()).toBe(1);

    await moveApp("active");
    await advance(0);
    expect(announced().filter((m) => m === WAITING)).toHaveLength(1);
    await moveApp("background");
    await moveApp("active");
    await advance(0);
    expect(announced().filter((m) => m === WAITING)).toHaveLength(1);
    expect(completeCalls()).toBe(1);
  });

  it("a success landing while blurred is silent there and said once back in front", async () => {
    fakeClock();
    const held = deferred<ProJob>();
    jest.mocked(apiPost).mockReturnValueOnce(held.promise as ReturnType<typeof apiPost>);
    await open(withAfter(1));
    await tapDone();

    await setFocused(false);
    const before = announced();
    jest.mocked(apiGet).mockResolvedValue(completed());
    await act(async () => held.resolve(completed()));
    await advance(0);
    expect(announced()).toEqual(before);
    expect(Haptics.notificationAsync).not.toHaveBeenCalled();
    expect(completeCalls()).toBe(1);

    await setFocused(true);
    await advance(0);
    expect(announced().filter((m) => m === WAITING)).toHaveLength(1);
    expect(completeCalls()).toBe(1);
  });
});
