import "@/i18n";

import { act, fireEvent, screen, waitFor, within } from "@testing-library/react-native";
import * as Haptics from "expo-haptics";
import { AccessibilityInfo } from "react-native";

import { ApiError, apiGet, apiPost, NetworkError, useSession } from "@/api";
import { dismissToast, toastStore } from "@/components/ui/toast";

import { deferred } from "../../../api/__tests__/helpers";
import { proJobQueryKey } from "../api";
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
  newQueryClient,
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
/** Where the fixtures' signed photo URLs live: no console call may ever carry it. */
const PHOTO_HOST = "photos.test.invalid";
const SIGNATURE = "X-Amz-Signature";

const PLAIN_GUIDE = "When the work is finished, tap Job's done.";
const NO_PHOTO_LINE = "Add at least one after photo first.";
const PHOTOS_FAILED_LINE = "We couldn't prepare your after photos. Add another one.";
const PROCESSING = "Finishing your photos…";
const SLOW = "Your photos are taking longer than usual. Try again in a moment.";
const WAITING = "Job's done. Waiting for Maria to confirm.";
const OFFLINE = "We couldn't reach Jack Fix It. Check your connection and try again.";

/** The calls Job's done makes over the whole retry window (one, then one every interval). */
const WINDOW_CALLS =
  Math.floor(proJobsConfig.doneRetryWindowMs / proJobsConfig.doneRetryIntervalMs) + 1;

const photo = (n: number): JobPhoto => ({
  id: `00000000-0000-4000-8000-0000000007${String(n).padStart(2, "0")}`,
  content_type: "image/jpeg",
  url: `https://${PHOTO_HOST}/jobs/after-${n}.jpg?${SIGNATURE}=sig-${n}`,
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

/** The job as the API answers a Job's done that went through. */
const completed = (): ProJob =>
  withAfter(1, { status: "completed", completed_at: minutesFromNow(0) });

const processing = () => new ApiError(409, "after_photos_processing");
const photosRequired = () => new ApiError(409, "after_photos_required");

const toast = () => toastStore.getState().current;
const actions = () => within(screen.getByTestId("pro-job-actions"));
const doneButton = () => screen.getByTestId("pro-job-done");
const doneMessage = () => screen.queryByTestId("pro-job-done-message");
const completeCalls = () =>
  jest.mocked(apiPost).mock.calls.filter(([path]) => path === COMPLETE).length;
const announced = () =>
  jest.mocked(AccessibilityInfo.announceForAccessibilityWithOptions).mock.calls.map(([m]) => m);
/** Moves the fake clock, letting every answer and re-render it releases land on the way. */
const advance = (ms: number) =>
  act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
const tapDone = () => act(async () => fireEvent.press(doneButton()));

/** Renders the screen and waits for the job's title (the API answered). */
async function open(job: ProJob, client = newQueryClient()) {
  jest.mocked(apiGet).mockResolvedValue(job);
  const view = await renderWithQuery(<ProJobScreen />, client);
  await screen.findByTestId("pro-job-title");
  return view;
}

const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug"] as const;
let consoleSpies: jest.SpyInstance[] = [];
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
  // Pass-through spies: what the code logs still shows, and the test reads every call.
  consoleSpies = CONSOLE_METHODS.map((method) => jest.spyOn(console, method));
  toastStore.setState({ current: null });
});

afterEach(() => {
  const logged = consoleSpies.flatMap((spy) =>
    spy.mock.calls.map((args: unknown[]) => args.map(String).join(" ")),
  );
  consoleSpies.forEach((spy) => spy.mockRestore());
  announceSpy.mockRestore();
  dismissToast();
  jest.useRealTimers();
  // No photo's signed URL (host or signature) ever reaches a log.
  expect(logged.filter((line) => line.includes(PHOTO_HOST) || line.includes(SIGNATURE))).toEqual(
    [],
  );
});

describe("Job's done", () => {
  it("is closed with no after photo on the job, and the dock says to add one", async () => {
    await open(working());

    expect(doneButton().props.accessibilityState).toMatchObject({ disabled: true });
    expect(actions().getByText(NO_PHOTO_LINE)).toBeTruthy();

    await tapDone();
    expect(apiPost).not.toHaveBeenCalled();
  });

  it("opens once an after photo is on the job, with no line above it", async () => {
    await open(withAfter(1));

    expect(doneButton().props.accessibilityState).toMatchObject({ disabled: false, busy: false });
    expect(actions().getByRole("button", { name: "Job's done" })).toBe(doneButton());
    expect(doneMessage()).toBeNull();
    expect(screen.getByText(PLAIN_GUIDE)).toBeTruthy();
  });

  it("posts once however fast the taps, and spins while the answer is out", async () => {
    const answer = deferred<ProJob>();
    jest.mocked(apiPost).mockReturnValueOnce(answer.promise as ReturnType<typeof apiPost>);
    await open(withAfter(1));

    await tapDone();
    await tapDone();

    expect(apiPost).toHaveBeenCalledTimes(1);
    expect(apiPost).toHaveBeenCalledWith(COMPLETE, undefined, {
      auth: true,
      generation: 1,
      params: { job_id: JOB_ID },
    });
    expect(doneButton().props.accessibilityState).toMatchObject({ disabled: true, busy: true });

    await act(async () => answer.resolve(completed()));
    await waitFor(() => expect(screen.queryByTestId("pro-job-actions")).toBeNull());
    expect(apiPost).toHaveBeenCalledTimes(1);
  });

  it("a Job's done that goes through shows the waiting state, with a success haptic, said once, and no dock", async () => {
    jest.mocked(apiPost).mockResolvedValueOnce(completed());
    await open(withAfter(1));

    await tapDone();

    await waitFor(() => expect(screen.queryByTestId("pro-job-actions")).toBeNull());
    expect(within(screen.getByTestId("pro-job-status")).getByText("Done")).toBeTruthy();
    expect(screen.getByTestId("pro-job-guide").props.children).toBe(WAITING);
    expect(screen.queryByTestId("pro-job-done")).toBeNull();
    expect(Haptics.notificationAsync).toHaveBeenCalledTimes(1);
    expect(Haptics.notificationAsync).toHaveBeenCalledWith(
      Haptics.NotificationFeedbackType.Success,
    );
    await waitFor(() => expect(announced()).toContain(WAITING));
    expect(announced().filter((message) => message === WAITING)).toHaveLength(1);
    expect(toast()).toBeNull();
  });

  describe("while the after photos' copies are made", () => {
    it("says it is finishing the photos, asks again every interval on its own, and lands when one goes through", async () => {
      fakeClock();
      jest
        .mocked(apiPost)
        .mockRejectedValueOnce(processing())
        .mockRejectedValueOnce(processing())
        .mockResolvedValueOnce(completed());
      await open(withAfter(1));

      await tapDone();

      expect(completeCalls()).toBe(1);
      expect(doneMessage()?.props.children).toBe(PROCESSING);
      expect(announced()).toEqual([PROCESSING]);
      expect(doneButton().props.accessibilityState).toMatchObject({ busy: true });
      expect(toast()).toBeNull();
      expect(Haptics.notificationAsync).not.toHaveBeenCalled();

      await advance(proJobsConfig.doneRetryIntervalMs - 1);
      expect(completeCalls()).toBe(1);
      await advance(1);
      expect(completeCalls()).toBe(2);
      expect(doneMessage()?.props.children).toBe(PROCESSING);
      // Said once, when it started finishing, not on every try.
      expect(announced()).toEqual([PROCESSING]);

      await advance(proJobsConfig.doneRetryIntervalMs);
      expect(completeCalls()).toBe(3);
      await waitFor(() => expect(screen.queryByTestId("pro-job-actions")).toBeNull());
      expect(screen.getByTestId("pro-job-guide").props.children).toBe(WAITING);
      expect(Haptics.notificationAsync).toHaveBeenCalledWith(
        Haptics.NotificationFeedbackType.Success,
      );

      await advance(proJobsConfig.doneRetryWindowMs);
      expect(completeCalls()).toBe(3);
    });

    it("asks exactly over the window, then says it is slow and offers Try again, which starts over", async () => {
      fakeClock();
      jest.mocked(apiPost).mockRejectedValue(processing());
      await open(withAfter(1));

      await tapDone();
      for (let tried = 1; tried < WINDOW_CALLS; tried += 1) {
        expect(doneMessage()?.props.children).toBe(PROCESSING);
        await advance(proJobsConfig.doneRetryIntervalMs);
      }

      expect(WINDOW_CALLS).toBe(11);
      expect(completeCalls()).toBe(11);
      expect(doneMessage()?.props.children).toBe(SLOW);
      expect(announced()).toEqual([PROCESSING, SLOW]);
      const tryAgain = actions().getByRole("button", { name: "Try again" });
      expect(tryAgain).toBe(doneButton());
      expect(tryAgain.props.accessibilityState).toMatchObject({ disabled: false, busy: false });
      expect(toast()).toBeNull();

      // Nothing more on its own.
      await advance(proJobsConfig.doneRetryWindowMs * 2);
      expect(completeCalls()).toBe(11);

      await tapDone();
      expect(completeCalls()).toBe(12);
      expect(doneMessage()?.props.children).toBe(PROCESSING);
      expect(actions().queryByRole("button", { name: "Try again" })).toBeNull();

      await advance(proJobsConfig.doneRetryWindowMs);
      expect(completeCalls()).toBe(22);
      expect(doneMessage()?.props.children).toBe(SLOW);
    });

    it("a newly saved after photo takes a slow Job's done back to its plain state", async () => {
      fakeClock();
      jest.mocked(apiPost).mockRejectedValue(processing());
      const client = newQueryClient();
      await open(withAfter(1), client);

      await tapDone();
      await advance(proJobsConfig.doneRetryWindowMs);
      expect(doneMessage()?.props.children).toBe(SLOW);

      // The job asked again after a second after photo was saved.
      jest.mocked(apiGet).mockResolvedValue(withAfter(2));
      await act(async () => {
        await client.invalidateQueries({ queryKey: proJobQueryKey(JOB_ID, 1) });
      });

      await waitFor(() => expect(doneMessage()).toBeNull());
      expect(actions().getByRole("button", { name: "Job's done" })).toBe(doneButton());
      expect(doneButton().props.accessibilityState).toMatchObject({ disabled: false });
      expect(completeCalls()).toBe(WINDOW_CALLS);
    });

    it("a session that ends during the wait asks nothing more and shows nothing", async () => {
      fakeClock();
      jest.mocked(apiPost).mockRejectedValue(processing());
      await open(withAfter(1));

      await tapDone();
      expect(completeCalls()).toBe(1);

      // Signed out, then another sign-in: the session generation moved on.
      mockSession.generation += 1;
      await advance(proJobsConfig.doneRetryWindowMs * 2);

      expect(completeCalls()).toBe(1);
      expect(doneMessage()?.props.children).not.toBe(SLOW);
      expect(announced()).not.toContain(SLOW);
      expect(toast()).toBeNull();
      expect(Haptics.notificationAsync).not.toHaveBeenCalled();
    });

    it("leaving the screen during the wait asks nothing more", async () => {
      fakeClock();
      jest.mocked(apiPost).mockRejectedValue(processing());
      const view = await open(withAfter(1));

      await tapDone();
      expect(completeCalls()).toBe(1);

      await view.unmount();
      await advance(proJobsConfig.doneRetryWindowMs * 2);

      expect(completeCalls()).toBe(1);
      expect(announced()).not.toContain(SLOW);
      expect(toast()).toBeNull();
    });
  });

  it("after_photos_required says to add an after photo and asks for the job again", async () => {
    jest.mocked(apiPost).mockRejectedValueOnce(photosRequired());
    await open(withAfter(1));
    expect(apiGet).toHaveBeenCalledTimes(1);
    // The copy failed: the job as asked again has no after photo left.
    jest.mocked(apiGet).mockResolvedValue(working());

    await tapDone();

    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
    expect(jest.mocked(apiGet).mock.calls[1]?.[1]).toMatchObject({
      generation: 1,
      params: { job_id: JOB_ID },
    });
    await waitFor(() =>
      expect(doneButton().props.accessibilityState).toMatchObject({ disabled: true }),
    );
    expect(doneMessage()?.props.children).toBe(NO_PHOTO_LINE);
    // Said as the answer came, while the photo was still listed: its copy could not be used.
    expect(announced()).toContain(PHOTOS_FAILED_LINE);
    expect(completeCalls()).toBe(1);
    expect(toast()).toBeNull();
  });

  it("after_photos_required with the photo still listed says its copy failed, in the danger tone", async () => {
    jest.mocked(apiPost).mockRejectedValueOnce(photosRequired());
    await open(withAfter(1));

    await tapDone();

    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(doneMessage()?.props.children).toBe(PHOTOS_FAILED_LINE));
    expect(announced()).toContain(PHOTOS_FAILED_LINE);
    expect(doneMessage()?.props.className).toContain("text-danger");
    expect(doneButton().props.accessibilityState).toMatchObject({ disabled: false, busy: false });
  });

  it("offline says so in a toast and leaves Job's done usable again", async () => {
    jest
      .mocked(apiPost)
      .mockRejectedValueOnce(new NetworkError(true))
      .mockResolvedValueOnce(completed());
    await open(withAfter(1));

    await tapDone();

    await waitFor(() => expect(toast()).toMatchObject({ message: OFFLINE, tone: "danger" }));
    await waitFor(() =>
      expect(doneButton().props.accessibilityState).toMatchObject({
        disabled: false,
        busy: false,
      }),
    );
    expect(doneMessage()).toBeNull();
    expect(apiGet).toHaveBeenCalledTimes(1);
    expect(Haptics.notificationAsync).not.toHaveBeenCalled();

    await tapDone();
    expect(completeCalls()).toBe(2);
    await waitFor(() => expect(screen.queryByTestId("pro-job-actions")).toBeNull());
    expect(screen.getByTestId("pro-job-guide").props.children).toBe(WAITING);
  });
});
