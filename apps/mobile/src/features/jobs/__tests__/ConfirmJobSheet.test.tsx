import i18n from "@/i18n";

import type { QueryClient } from "@tanstack/react-query";
import { act, fireEvent, screen } from "@testing-library/react-native";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { AccessibilityInfo } from "react-native";

import { ApiError, apiPost, NetworkError, SessionExpiredError } from "@/api";
import { dismissToast, toastStore } from "@/components/ui/toast";
import { MY_REQUESTS_QUERY_KEY } from "@/features/history/useMyRequests";

import { deferred } from "../../../api/__tests__/helpers";
import {
  freezeClock,
  navigation,
  newQueryClient,
  renderWithQuery,
} from "../../pro-jobs/__tests__/helpers";
import { REQUEST_ID } from "../../quotes/__tests__/helpers";
import { activeJobQueryKey, customerJobQueryKey } from "../api";
import { ConfirmJobSheet } from "../ConfirmJobSheet";
import type { CustomerJob } from "../phase";

import { confirmedJob, customerJob } from "./helpers";

jest.mock("@/api", () => jest.requireActual("../../pro-jobs/__tests__/helpers").apiMock());
jest.mock("expo-router", () => jest.requireActual("../../pro-jobs/__tests__/helpers").routerMock);
jest.mock("expo-haptics");
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);

const CONFIRM = "/v1/requests/{request_id}/job/confirm";
const PINNED = { auth: true, generation: 1, params: { request_id: REQUEST_ID } };
const OFFLINE = "We couldn't reach Jack Fix It. Check your connection and try again.";
const FINISHED = customerJob();
const CONFIRMED = confirmedJob();

const session = () =>
  jest.requireMock<{ mockSession: { generation: number } }>("@/api").mockSession;
const post = () => jest.mocked(apiPost);
const posts = () => post().mock.calls.filter(([path]) => path === CONFIRM);
const toast = () => toastStore.getState().current;
const announced = () =>
  jest.mocked(AccessibilityInfo.announceForAccessibilityWithOptions).mock.calls.map(([m]) => m);
const cached = (client: QueryClient) =>
  client.getQueryData<CustomerJob>(customerJobQueryKey(REQUEST_ID, 1));

const press = async (testID: string) => {
  await act(async () => {
    await fireEvent.press(screen.getByTestId(testID));
  });
};

/** Opens the sheet over the job the screen under it holds. */
async function open(job: CustomerJob | null = FINISHED) {
  const client = newQueryClient();
  if (job) client.setQueryData(customerJobQueryKey(REQUEST_ID, 1), job);
  const invalidate = jest.spyOn(client, "invalidateQueries");
  await renderWithQuery(<ConfirmJobSheet />, client);
  return { client, invalidate };
}

beforeEach(() => {
  freezeClock();
  navigation.reset();
  navigation.setParams({ id: REQUEST_ID });
  session().generation = 1;
  post().mockReset();
  jest.mocked(router.back).mockClear();
  jest.mocked(Haptics.notificationAsync).mockClear();
  jest.mocked(AccessibilityInfo.announceForAccessibilityWithOptions).mockClear();
  toastStore.getState().current = null;
});

afterEach(async () => {
  dismissToast(); // a shown toast arms its own dismiss timer
  jest.useRealTimers();
  await act(() => i18n.changeLanguage("en"));
});

describe("ConfirmJobSheet (#66)", () => {
  it("says what confirming does, with Confirm and Not yet", async () => {
    await open();

    expect(screen.getByText("Confirm the job is done?")).toBeTruthy();
    expect(screen.getByTestId("confirm-job-body").props.children).toBe(
      "Payment is released to Dan.",
    );
    expect(screen.getByRole("button", { name: "Confirm" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Not yet" })).toBeTruthy();
    expect(router.back).not.toHaveBeenCalled();
  });

  it("confirms once however fast the taps, pinned to the session, and closes over the confirmed job", async () => {
    const answer = deferred<CustomerJob>();
    post().mockReturnValue(answer.promise as ReturnType<typeof apiPost>);
    const { client, invalidate } = await open();

    await press("confirm-job-send");
    await press("confirm-job-send");
    expect(posts()).toEqual([[CONFIRM, undefined, PINNED]]);
    expect(screen.getByTestId("confirm-job-cancel").props.accessibilityState?.disabled).toBe(true);

    await act(async () => answer.resolve(CONFIRMED));

    // The screen under the sheet holds the confirmed job at once; the banner and History ask again.
    expect(cached(client)).toEqual(CONFIRMED);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: activeJobQueryKey(1) });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: MY_REQUESTS_QUERY_KEY });
    expect(Haptics.notificationAsync).toHaveBeenCalledWith(
      Haptics.NotificationFeedbackType.Success,
    );
    // Closed once: by the answer, not again by the job leaving "finished" under it.
    expect(router.back).toHaveBeenCalledTimes(1);
    expect(toast()).toBeNull();
    expect(posts()).toHaveLength(1);
  });

  it.each([
    [
      "moved on (409)",
      new ApiError(409, "job_not_completed"),
      "This job changed. Here's where it stands now.",
    ],
    ["gone (404)", new ApiError(404, "not_found"), "This job is no longer available."],
  ])(
    "a job that %s: the sheet closes, says so, and the job is asked for again",
    async (_name, error, message) => {
      post().mockRejectedValue(error);
      const { client, invalidate } = await open();

      await press("confirm-job-send");

      expect(toast()).toMatchObject({ message, tone: "danger" });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: customerJobQueryKey(REQUEST_ID, 1) });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: activeJobQueryKey(1) });
      expect(router.back).toHaveBeenCalledTimes(1);
      expect(cached(client)).toEqual(FINISHED);
      expect(Haptics.notificationAsync).not.toHaveBeenCalled();
    },
  );

  it("offline, the reason shows and is said aloud, the sheet stays, and Confirm again goes", async () => {
    post().mockRejectedValueOnce(new NetworkError(false)).mockResolvedValueOnce(CONFIRMED);
    const { client } = await open();

    await press("confirm-job-send");

    expect(screen.getByTestId("confirm-job-failure").props.children).toBe(OFFLINE);
    expect(announced()).toEqual([OFFLINE]);
    expect(router.back).not.toHaveBeenCalled();
    expect(toast()).toBeNull();

    await press("confirm-job-send");

    expect(posts()).toHaveLength(2);
    expect(cached(client)).toEqual(CONFIRMED);
    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it("a server error keeps the sheet with a retry, the job untouched", async () => {
    post().mockRejectedValue(new ApiError(500, "internal_error"));
    const { client } = await open();

    await press("confirm-job-send");

    expect(screen.getByTestId("confirm-job-failure").props.children).toBe(
      "We couldn't confirm the job. Please try again.",
    );
    expect(router.back).not.toHaveBeenCalled();
    expect(cached(client)).toEqual(FINISHED);
  });

  it("Not yet closes without confirming", async () => {
    await open();

    await press("confirm-job-cancel");

    expect(router.back).toHaveBeenCalledTimes(1);
    expect(posts()).toHaveLength(0);
  });

  it("an answer after a sign-out does nothing: no cache write, no haptic, no toast, no close", async () => {
    const answer = deferred<CustomerJob>();
    post().mockReturnValue(answer.promise as ReturnType<typeof apiPost>);
    const { client, invalidate } = await open();

    await press("confirm-job-send");
    session().generation = 2;
    await act(async () => answer.resolve(CONFIRMED));

    expect(cached(client)).toEqual(FINISHED);
    expect(invalidate).not.toHaveBeenCalled();
    expect(Haptics.notificationAsync).not.toHaveBeenCalled();
    expect(toast()).toBeNull();
    expect(router.back).not.toHaveBeenCalled();
  });

  it.each([
    ["a refusal", new ApiError(409, "job_not_completed")],
    ["an expired session", new SessionExpiredError()],
  ])("%s landing after a sign-out says nothing and asks for nothing", async (_name, error) => {
    const answer = deferred<CustomerJob>();
    post().mockReturnValue(answer.promise as ReturnType<typeof apiPost>);
    const { invalidate } = await open();

    await press("confirm-job-send");
    session().generation = 2;
    await act(async () => answer.reject(error));

    expect(toast()).toBeNull();
    expect(invalidate).not.toHaveBeenCalled();
    expect(screen.queryByTestId("confirm-job-failure")).toBeNull();
    expect(router.back).not.toHaveBeenCalled();
  });

  it("opened over a job that is not finished (a stale link), it closes at once and sends nothing", async () => {
    await open(CONFIRMED);

    expect(router.back).toHaveBeenCalledTimes(1);
    expect(posts()).toHaveLength(0);
  });

  it("opened with no job on screen, it draws nothing and closes", async () => {
    await open(null);

    expect(screen.queryByTestId("confirm-job-sheet")).toBeNull();
    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it("the job confirming itself under the sheet (the 48 h confirmation) closes it once", async () => {
    const { client } = await open();

    await act(async () => client.setQueryData(customerJobQueryKey(REQUEST_ID, 1), CONFIRMED));
    await act(async () =>
      client.setQueryData(customerJobQueryKey(REQUEST_ID, 1), { ...CONFIRMED }),
    );

    expect(router.back).toHaveBeenCalledTimes(1);
    expect(posts()).toHaveLength(0);
  });

  it("speaks Spanish", async () => {
    await act(() => i18n.changeLanguage("es"));
    await open();

    expect(screen.getByText("¿Confirmas que el trabajo está terminado?")).toBeTruthy();
    expect(screen.getByTestId("confirm-job-body").props.children).toBe("El pago se libera a Dan.");
    expect(screen.getByRole("button", { name: "Confirmar" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Todavía no" })).toBeTruthy();
  });
});
