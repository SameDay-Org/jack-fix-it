import "@/i18n";

import { act, fireEvent, screen, waitFor, within } from "@testing-library/react-native";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { AccessibilityInfo } from "react-native";

import { ApiError, apiPost, NetworkError, SessionExpiredError } from "@/api";
import { dismissToast, toastStore } from "@/components/ui/toast";
import { formatTimeOfDay } from "@/features/opportunities/format";

import { deferred } from "../../../api/__tests__/helpers";
import { proJobQueryKey } from "../api";
import { OnTheWaySheet } from "../OnTheWaySheet";
import type { ProJob } from "../phase";

import {
  apiMock,
  freezeClock,
  JOB_ID,
  minutesFromNow,
  navigation,
  newQueryClient,
  NOW,
  onTheWay,
  proJob,
  renderWithQuery,
  working,
} from "./helpers";

jest.mock("@/api", () => jest.requireActual("./helpers").apiMock());
jest.mock("expo-router", () => jest.requireActual("./helpers").routerMock);
jest.mock("expo-haptics");
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);

const { mockSession } = jest.requireMock<ReturnType<typeof apiMock>>("@/api");

const ON_THE_WAY = "/v1/pros/me/jobs/{job_id}/on-the-way";
const PINNED = { auth: true, generation: 1, params: { job_id: JOB_ID } };
const MINUTE_MS = 60_000;
const OFFLINE = "We couldn't reach Jack Fix It. Check your connection and try again.";

const NO_BREAK_SPACE = String.fromCharCode(0xa0);
/** Labels keep their words together with no-break spaces; tests read them with plain ones. */
const plain = (text: unknown) => String(text).replaceAll(NO_BREAK_SPACE, " ");
const announced = () =>
  jest.mocked(AccessibilityInfo.announceForAccessibilityWithOptions).mock.calls.map(([m]) => m);
const sendButton = () => screen.getByTestId("on-the-way-send");
const isDisabled = (testID: string) =>
  screen.getByTestId(testID).props.accessibilityState?.disabled === true;
const isChecked = (testID: string) =>
  screen.getByTestId(testID).props.accessibilityState?.checked === true;
const customValue = () => plain(screen.getByTestId("on-the-way-custom-value").props.children);
const arrivalAt = (minutes: number) =>
  `You'll arrive around ${formatTimeOfDay(NOW + minutes * MINUTE_MS)}.`;

const press = async (testID: string) => {
  await act(async () => {
    await fireEvent.press(screen.getByTestId(testID));
  });
};

/** Opens the sheet over the job the screen under it holds in the cache (none: a stale link). */
async function open(job: ProJob | null = proJob()) {
  const client = newQueryClient();
  if (job) client.setQueryData(proJobQueryKey(JOB_ID, 1), job);
  await renderWithQuery(<OnTheWaySheet />, client);
  return client;
}

beforeEach(() => {
  freezeClock();
  navigation.reset();
  navigation.setParams({ id: JOB_ID });
  mockSession.generation = 1;
  jest.mocked(apiPost).mockReset();
  jest.mocked(router.back).mockClear();
  jest.mocked(Haptics.notificationAsync).mockClear();
  jest.mocked(AccessibilityInfo.announceForAccessibilityWithOptions).mockClear();
  toastStore.getState().current = null;
});

afterEach(() => {
  dismissToast(); // a shown toast arms its own dismiss timer
  jest.useRealTimers();
});

describe("OnTheWaySheet", () => {
  it("offers the presets and Other as radios in one group, none picked, and Send waits for a pick", async () => {
    await open();

    expect(screen.getByText("When will you get there?")).toBeTruthy();
    expect(screen.getByTestId("on-the-way-body").props.children).toBe(
      "We'll show Maria the time you expect to arrive.",
    );
    // The group is a container, not one focus stop: its role and name are read from its props.
    const group = screen.getByTestId("on-the-way-choices");
    expect(group.props).toMatchObject({
      accessibilityRole: "radiogroup",
      accessibilityLabel: "Arrival time",
    });
    const radios = within(group).getAllByRole("radio");
    expect(radios.map((radio) => plain(radio.props.accessibilityLabel))).toEqual([
      "10 min",
      "20 min",
      "30 min",
      "45 min",
      "1 h",
      "Other",
    ]);
    expect(radios.every((radio) => radio.props.accessibilityState.checked === false)).toBe(true);
    expect(isDisabled("on-the-way-send")).toBe(true);
    expect(screen.queryByTestId("on-the-way-arrival")).toBeNull();
    expect(screen.queryByTestId("on-the-way-custom")).toBeNull();

    await press("on-the-way-send");
    expect(apiPost).not.toHaveBeenCalled();
  });

  it("a preset posts its minutes pinned to the session and closes the sheet once, even as the job moves on", async () => {
    const client = await open();
    const answer = deferred<ProJob>();
    jest.mocked(apiPost).mockReturnValueOnce(answer.promise as ReturnType<typeof apiPost>);

    await press("on-the-way-preset-20");
    expect(isChecked("on-the-way-preset-20")).toBe(true);
    expect(isChecked("on-the-way-preset-10")).toBe(false);
    expect(screen.getByTestId("on-the-way-arrival").props.children).toBe(arrivalAt(20));
    expect(isDisabled("on-the-way-send")).toBe(false);

    await press("on-the-way-send");
    expect(apiPost).toHaveBeenCalledTimes(1);
    expect(apiPost).toHaveBeenCalledWith(ON_THE_WAY, { eta_minutes: 20 }, PINNED);

    const moved = onTheWay();
    await act(async () => answer.resolve(moved));
    await waitFor(() => expect(router.back).toHaveBeenCalledTimes(1));
    expect(client.getQueryData(proJobQueryKey(JOB_ID, 1))).toEqual(moved);
    expect(Haptics.notificationAsync).toHaveBeenCalledWith(
      Haptics.NotificationFeedbackType.Success,
    );
    // Not an update: nothing to announce beyond the screen under it.
    expect(announced()).not.toContain("Arrival time updated.");

    // The job moves past the arrival time while the sheet slides away: still one back.
    await act(async () => {
      client.setQueryData(proJobQueryKey(JOB_ID, 1), working());
    });
    await waitFor(() => expect(screen.getByTestId("on-the-way-sheet")).toBeTruthy());
    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it("Other starts the custom time at the last pick, steps 5 min below an hour and 15 above, and posts it", async () => {
    await open();
    jest.mocked(apiPost).mockResolvedValueOnce(onTheWay());

    await press("on-the-way-preset-45");
    await press("on-the-way-other");
    expect(isChecked("on-the-way-other")).toBe(true);
    expect(isChecked("on-the-way-preset-45")).toBe(false);
    expect(customValue()).toBe("45 min");
    expect(screen.getByTestId("on-the-way-custom").props.accessibilityLabel).toBe("Arrive in");

    const seen: string[] = [];
    for (let step = 0; step < 4; step += 1) {
      await press("on-the-way-custom-increment");
      seen.push(customValue());
    }
    expect(seen).toEqual(["50 min", "55 min", "1 h", "1 h 15 min"]);

    await press("on-the-way-custom-decrement");
    expect(customValue()).toBe("1 h");
    await press("on-the-way-custom-decrement");
    expect(customValue()).toBe("55 min");
    expect(screen.getByTestId("on-the-way-arrival").props.children).toBe(arrivalAt(55));
    expect(screen.getByRole("button", { name: "Earlier" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Later" })).toBeTruthy();

    await press("on-the-way-send");
    expect(apiPost).toHaveBeenCalledWith(ON_THE_WAY, { eta_minutes: 55 }, PINNED);
    await waitFor(() => expect(router.back).toHaveBeenCalledTimes(1));
  });

  it("Other with nothing picked starts at the largest preset", async () => {
    await open();

    await press("on-the-way-other");

    expect(customValue()).toBe("1 h");
    expect(screen.getByTestId("on-the-way-arrival").props.children).toBe(arrivalAt(60));
  });

  it("the arrival preview counts from the last pick, not from when the sheet opened", async () => {
    await open();

    // Seven minutes after the sheet opened, the pro picks 20 min.
    jest.setSystemTime(NOW + 7 * MINUTE_MS);
    await press("on-the-way-preset-20");
    expect(screen.getByTestId("on-the-way-arrival").props.children).toBe(arrivalAt(27));

    // Three minutes on, Other starts at that pick and counts from now.
    jest.setSystemTime(NOW + 10 * MINUTE_MS);
    await press("on-the-way-other");
    expect(screen.getByTestId("on-the-way-arrival").props.children).toBe(arrivalAt(30));

    // A step two minutes later counts from that step.
    jest.setSystemTime(NOW + 12 * MINUTE_MS);
    await press("on-the-way-custom-increment");
    expect(screen.getByTestId("on-the-way-arrival").props.children).toBe(arrivalAt(37));
    jest.setSystemTime(NOW + 13 * MINUTE_MS);
    await press("on-the-way-custom-decrement");
    expect(screen.getByTestId("on-the-way-arrival").props.children).toBe(arrivalAt(33));
  });

  it("the custom time stops at 5 min and at 4 h", async () => {
    await open();
    await press("on-the-way-other");

    for (let step = 0; step < 11; step += 1) await press("on-the-way-custom-decrement");
    expect(customValue()).toBe("5 min");
    expect(isDisabled("on-the-way-custom-decrement")).toBe(true);
    expect(isDisabled("on-the-way-custom-increment")).toBe(false);
    await press("on-the-way-custom-decrement");
    expect(customValue()).toBe("5 min");

    for (let step = 0; step < 47; step += 1) {
      if (isDisabled("on-the-way-custom-increment")) break;
      await press("on-the-way-custom-increment");
    }
    expect(customValue()).toBe("4 h");
    expect(isDisabled("on-the-way-custom-increment")).toBe(true);
    expect(isDisabled("on-the-way-custom-decrement")).toBe(false);
  });

  it("on the way already, it updates the arrival time and says so", async () => {
    const job = onTheWay();
    await open(job);
    jest.mocked(apiPost).mockResolvedValueOnce(onTheWay({ eta_at: minutesFromNow(30) }));

    expect(screen.getByText("Update your arrival time")).toBeTruthy();
    expect(screen.getByTestId("on-the-way-body").props.children).toBe(
      `You said you'd arrive by ${formatTimeOfDay(NOW + 20 * MINUTE_MS)}.`,
    );
    expect(screen.getByRole("button", { name: "Update arrival time" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "I'm on my way" })).toBeNull();

    await press("on-the-way-preset-30");
    await press("on-the-way-send");

    expect(apiPost).toHaveBeenCalledWith(ON_THE_WAY, { eta_minutes: 30 }, PINNED);
    await waitFor(() => expect(router.back).toHaveBeenCalledTimes(1));
    expect(announced()).toContain("Arrival time updated.");
    expect(screen.getByText("Update your arrival time")).toBeTruthy();
  });

  it("offline, the sheet stays with the reason and nothing closes", async () => {
    await open();
    jest.mocked(apiPost).mockRejectedValueOnce(new NetworkError(false));

    await press("on-the-way-preset-10");
    await press("on-the-way-send");

    expect(await screen.findByTestId("on-the-way-offline")).toHaveTextContent(OFFLINE);
    expect(announced()).toContain(OFFLINE);
    expect(router.back).not.toHaveBeenCalled();
    expect(toastStore.getState().current).toBeNull();
    expect(isDisabled("on-the-way-send")).toBe(false);
  });

  it("a job that changed (409) closes the sheet once with the changed toast", async () => {
    const client = await open();
    jest.mocked(apiPost).mockRejectedValueOnce(new ApiError(409, "invalid_transition"));

    await press("on-the-way-preset-10");
    await press("on-the-way-send");

    await waitFor(() => expect(router.back).toHaveBeenCalledTimes(1));
    expect(toastStore.getState().current).toMatchObject({
      message: "This job changed. Here's where it stands now.",
      tone: "danger",
    });

    // The refreshed job arrives on the way: the sheet does not close a second time.
    await act(async () => {
      client.setQueryData(proJobQueryKey(JOB_ID, 1), working());
    });
    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["no job in the cache (a stale link)", null],
    ["a job already working", working()],
  ])("opened over %s, it closes once and sends nothing", async (_case, job) => {
    await open(job);

    await waitFor(() => expect(router.back).toHaveBeenCalledTimes(1));
    await act(async () => undefined);
    expect(router.back).toHaveBeenCalledTimes(1);
    expect(apiPost).not.toHaveBeenCalled();
  });

  it("a double tap sends once", async () => {
    await open();
    const answer = deferred<ProJob>();
    jest.mocked(apiPost).mockReturnValueOnce(answer.promise as ReturnType<typeof apiPost>);

    await press("on-the-way-preset-30");
    await press("on-the-way-send");
    await press("on-the-way-send");
    expect(sendButton().props.accessibilityState).toMatchObject({ busy: true, disabled: true });

    await act(async () => answer.resolve(onTheWay()));
    await waitFor(() => expect(router.back).toHaveBeenCalledTimes(1));
    expect(apiPost).toHaveBeenCalledTimes(1);
  });

  /** Sends a pick, then signs out (the generation moves) and the request is refused as superseded. */
  async function signOutMidRequest() {
    const client = await open();
    const answer = deferred<ProJob>();
    jest.mocked(apiPost).mockReturnValueOnce(answer.promise as ReturnType<typeof apiPost>);
    await press("on-the-way-preset-20");
    await press("on-the-way-send");
    mockSession.generation = 2;
    await act(async () => answer.reject(new SessionExpiredError("superseded")));
    await act(async () => undefined);
    return client;
  }

  it("a sign-out while the request is out says nothing and leaves the old session's job alone", async () => {
    const client = await signOutMidRequest();

    expect(toastStore.getState().current).toBeNull();
    expect(screen.queryByTestId("on-the-way-offline")).toBeNull();
    expect(announced()).toEqual([]);
    expect(Haptics.notificationAsync).not.toHaveBeenCalled();
    expect(client.getQueryData(proJobQueryKey(JOB_ID, 1))).toEqual(proJob());
    // The next session has no job here: the sheet draws nothing for it.
    expect(screen.queryByTestId("on-the-way-sheet")).toBeNull();
  });

  // The sheet closes only for the session it opened in: a sign-out empties the cache it read,
  // which is not the job moving on.
  it("a sign-out while the request is out closes nothing", async () => {
    await signOutMidRequest();

    expect(router.back).not.toHaveBeenCalled();
  });
});
