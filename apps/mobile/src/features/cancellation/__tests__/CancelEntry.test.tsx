import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import type { ReactNode } from "react";

import i18n from "@/i18n";
import { ApiError, NetworkError, SessionExpiredError } from "@/api";
import type { CustomerJob } from "@/features/jobs/phase";

import {
  callPath,
  deferred,
  errorResponse,
  installFetchMock,
  jsonResponse,
  resetSecureStore,
  settle,
  user,
  type FetchMock,
} from "../../../api/__tests__/helpers";
import { attachQueryClient, sessionStore } from "../../../api/session";
import { SIGNED_OUT } from "../../auth/__tests__/helpers";
import { customerJob } from "../../jobs/__tests__/helpers";
import { cancelFailureOf, isRateLimited, mayCancel, refusalOf, type CancelPreview } from "../api";
import { CancelEntry } from "../CancelEntry";

jest.mock(
  "../../../api/config",
  () => jest.requireActual("../../../api/__tests__/helpers").configMock,
);
jest.mock(
  "expo-secure-store",
  () => jest.requireActual("../../../api/__tests__/helpers").secureStoreMock,
);

const SCHEDULED = customerJob({ status: "scheduled" });
const PREVIEW_PATH = `/v1/jobs/${SCHEDULED.id}/cancel-preview`;
const FREE: CancelPreview = {
  job_id: SCHEDULED.id,
  job_status: "scheduled",
  fee_applies: false,
  fee_bps: 1500,
  customer_total_cents: 18_050,
  fee_cents: 0,
  refund_cents: 18_050,
  currency: "usd",
};

let fetchMock: FetchMock;
let client: QueryClient;
let answer: () => Promise<Response>;
let onPress: jest.Mock;

const respond = (preview: CancelPreview) => () => Promise.resolve(jsonResponse(200, preview));
const refuse = (status: number, code: string) => () => Promise.resolve(errorResponse(status, code));
const reads = () => fetchMock.mock.calls.filter((call) => callPath(call) === PREVIEW_PATH).length;
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
);
const entry = (job: CustomerJob, updatedAt: number) => (
  <CancelEntry job={job} updatedAt={updatedAt} onPress={onPress} />
);

async function renderEntry(job: CustomerJob = SCHEDULED, updatedAt = Date.now()) {
  const rendered = await render(entry(job, updatedAt), { wrapper });
  await act(settle);
  return rendered;
}

beforeEach(async () => {
  answer = respond(FREE);
  onPress = jest.fn();
  fetchMock = installFetchMock();
  fetchMock.mockImplementation(async (...call) =>
    callPath(call) === PREVIEW_PATH ? answer() : errorResponse(404, "not_found"),
  );
  resetSecureStore();
  client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } });
  attachQueryClient(client);
  await i18n.changeLanguage("en");
  sessionStore.setState({
    ...SIGNED_OUT,
    status: "signedIn",
    user,
    accessToken: "access-1",
    accessTokenExpiresAt: Date.now() + 900_000,
  });
});

describe("Cancel job on the job screen", () => {
  it("is offered while the API's preview answers, and opens the cancel screen", async () => {
    await renderEntry();
    await fireEvent.press(await screen.findByRole("button", { name: "Cancel job" }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it.each(["cancel_not_allowed", "cancel_needs_review"])(
    "is left out when the API refuses (%s), with no retry",
    async (code) => {
      answer = refuse(409, code);
      await renderEntry();
      await waitFor(() => expect(reads()).toBe(1));
      await act(settle);
      expect(screen.queryByTestId("job-cancel")).toBeNull();
      expect(screen.queryByTestId("job-cancel-check-failed")).toBeNull();
    },
  );

  it("is left out while the preview loads; a failed read says so and its retry brings it", async () => {
    const held = deferred<Response>();
    answer = () => held.promise;
    await renderEntry();
    expect(screen.queryByTestId("job-cancel")).toBeNull();
    await act(async () => {
      held.resolve(errorResponse(503, "unavailable"));
      await settle();
    });
    expect(await screen.findByTestId("job-cancel-check-failed")).toHaveTextContent(
      "We couldn't check if this job can be cancelled. Try again",
    );
    expect(screen.queryByTestId("job-cancel")).toBeNull();
    answer = respond(FREE);
    await fireEvent.press(screen.getByTestId("job-cancel-check-failed"));
    expect(await screen.findByTestId("job-cancel")).toBeTruthy();
    expect(reads()).toBe(2);
  });

  it("is left out when the API asks to wait (429), says so calmly, and its retry brings it", async () => {
    answer = refuse(429, "rate_limited");
    await renderEntry();
    expect(await screen.findByTestId("job-cancel-check-failed")).toHaveTextContent(
      "We need a moment to check if this job can be cancelled. Try again",
    );
    expect(screen.queryByTestId("job-cancel")).toBeNull();
    expect(screen.queryByText(/rate_limited|API request failed/)).toBeNull();
    answer = respond(FREE);
    await fireEvent.press(screen.getByTestId("job-cancel-check-failed"));
    expect(await screen.findByTestId("job-cancel")).toBeTruthy();
    expect(reads()).toBe(2);
  });

  it.each([
    [429, "rate_limited", "We need a moment to check if this job can be cancelled. Try again"],
    [503, "unavailable", "We couldn't check if this job can be cancelled. Try again"],
  ])(
    "is taken back when a later read fails (%s), and returns with the next answer",
    async (status, code, line) => {
      const first = Date.now();
      const rendered = await renderEntry(SCHEDULED, first);
      expect(await screen.findByTestId("job-cancel")).toBeTruthy();
      // The pro set off: the cost is read again and the read fails. The earlier answer (free)
      // says nothing of the cost now.
      const onTheWay: CustomerJob = { ...SCHEDULED, status: "on_the_way" };
      answer = refuse(status, code);
      await rendered.rerender(entry(onTheWay, first + 1_000));
      expect(await screen.findByTestId("job-cancel-check-failed")).toHaveTextContent(line);
      expect(screen.queryByTestId("job-cancel")).toBeNull();
      answer = respond({ ...FREE, job_status: "on_the_way", fee_applies: true, fee_cents: 1_234 });
      await rendered.rerender(entry(onTheWay, first + 2_000));
      expect(await screen.findByTestId("job-cancel")).toBeTruthy();
      expect(reads()).toBe(3);
    },
  );

  it("reads a failed preview again with the next answer for the job", async () => {
    answer = refuse(503, "unavailable");
    const first = Date.now();
    const rendered = await renderEntry(SCHEDULED, first);
    expect(await screen.findByTestId("job-cancel-check-failed")).toBeTruthy();
    answer = respond(FREE);
    await rendered.rerender(entry(SCHEDULED, first + 1_000));
    await waitFor(() => expect(reads()).toBe(2));
    expect(await screen.findByTestId("job-cancel")).toBeTruthy();
  });

  it("asks nothing more on a new answer for the job while the preview stands", async () => {
    const first = Date.now();
    const rendered = await renderEntry(SCHEDULED, first);
    expect(await screen.findByTestId("job-cancel")).toBeTruthy();
    await rendered.rerender(entry(SCHEDULED, first + 1_000));
    await act(settle);
    expect(reads()).toBe(1);
  });

  it("reads it again when the job moves on, and leaves it out once the API refuses", async () => {
    const first = Date.now();
    const rendered = await renderEntry(SCHEDULED, first);
    expect(await screen.findByTestId("job-cancel")).toBeTruthy();
    // The cached preview said yes; the job moved on and the API now says no.
    answer = refuse(409, "cancel_not_allowed");
    await rendered.rerender(entry({ ...SCHEDULED, status: "on_the_way" }, first + 1_000));
    await waitFor(() => expect(reads()).toBe(2));
    await waitFor(() => expect(screen.queryByTestId("job-cancel")).toBeNull());
  });
});

describe("the cancel's API helpers", () => {
  it("asks for a preview only for a job the API may cancel", () => {
    expect(mayCancel("scheduled")).toBe(true);
    expect(mayCancel("on_the_way")).toBe(true);
    for (const status of ["in_progress", "completed", "confirmed", "disputed", "cancelled"]) {
      expect(mayCancel(status)).toBe(false);
    }
  });

  it("names a refusal from its code only", () => {
    expect(refusalOf(new ApiError(409, "cancel_not_allowed"))).toBe("notAllowed");
    expect(refusalOf(new ApiError(409, "cancel_needs_review"))).toBe("needsReview");
    expect(refusalOf(new ApiError(409, "something_else"))).toBeNull();
    expect(refusalOf(new ApiError(503, "unavailable"))).toBeNull();
    expect(refusalOf(new ApiError(429, "rate_limited"))).toBeNull();
    expect(refusalOf(new NetworkError(false))).toBeNull();
  });

  it("knows a wait the API asked for by its status only", () => {
    expect(isRateLimited(new ApiError(429, "rate_limited"))).toBe(true);
    expect(isRateLimited(new ApiError(429, undefined))).toBe(true);
    expect(isRateLimited(new ApiError(409, "cancel_not_allowed"))).toBe(false);
    expect(isRateLimited(new ApiError(503, "unavailable"))).toBe(false);
    expect(isRateLimited(new NetworkError(false))).toBe(false);
  });

  it("maps every failure to the screen's own words", () => {
    expect(cancelFailureOf(new SessionExpiredError())).toBeNull();
    expect(cancelFailureOf(new ApiError(429, "rate_limited"))).toBe("rateLimited");
    expect(cancelFailureOf(new NetworkError(false))).toBe("offline");
    expect(cancelFailureOf(new ApiError(409, "cancel_fee_changed"))).toBe("feeChanged");
    expect(cancelFailureOf(new ApiError(409, "cancel_not_allowed"))).toBe("closed");
    expect(cancelFailureOf(new ApiError(409, "idempotency_key_reused"))).toBe("closed");
    expect(cancelFailureOf(new ApiError(422, "validation_error"))).toBe("invalid");
    expect(cancelFailureOf(new ApiError(500, "internal_error"))).toBe("failed");
    expect(cancelFailureOf(new Error("boom"))).toBe("failed");
  });
});
