import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import i18n from "@/i18n";

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
import { METRICS, SIGNED_OUT } from "../../auth/__tests__/helpers";
import { ConfirmDock } from "../../jobs/FinishedJob";
import { customerJob } from "../../jobs/__tests__/helpers";
import type { CustomerDispute, CustomerDisputeView } from "../api";
import { hasReport, ReportStatus } from "../ReportStatus";

jest.mock(
  "../../../api/config",
  () => jest.requireActual("../../../api/__tests__/helpers").configMock,
);
jest.mock(
  "expo-secure-store",
  () => jest.requireActual("../../../api/__tests__/helpers").secureStoreMock,
);
jest.mock("expo-router", () => jest.requireActual("../../home/__tests__/helpers").homeRouterMock());
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);

const REQUEST_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const DISPUTED = customerJob({ status: "disputed" });
const DISPUTE_PATH = `/v1/jobs/${DISPUTED.id}/dispute`;

const dispute = (overrides: Partial<CustomerDispute> = {}): CustomerDispute => ({
  id: "0f8fad5b-d9cb-469f-a165-70867728950e",
  reason_code: "work_incomplete",
  description: "Half the fence is still down.",
  status: "open",
  resolution: null,
  created_at: new Date().toISOString(),
  resolved_at: null,
  photos: [],
  photos_pending: 0,
  ...overrides,
});

let fetchMock: FetchMock;
let client: QueryClient;
/** What `GET /v1/jobs/{id}/dispute` answers: a view, a failure, or an answer the test holds. */
let answer: () => Promise<Response>;

const wrapper = ({ children }: { children: ReactNode }) => (
  <SafeAreaProvider initialMetrics={METRICS}>
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  </SafeAreaProvider>
);
const respond = (view: CustomerDisputeView) => () => Promise.resolve(jsonResponse(200, view));
const reads = () => fetchMock.mock.calls.filter((call) => callPath(call) === DISPUTE_PATH).length;

beforeEach(async () => {
  answer = respond({ dispute: dispute(), can_report: false, report_by: null });
  fetchMock = installFetchMock();
  fetchMock.mockImplementation(async (...call) =>
    callPath(call) === DISPUTE_PATH ? answer() : errorResponse(404, "not_found"),
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

afterEach(() => i18n.changeLanguage("en"));

describe("hasReport", () => {
  it("is the disputed job, or one the timeline shows was disputed", () => {
    const moved = (status: "disputed" | "completed") => ({
      type: "status_changed" as const,
      status,
      at: new Date().toISOString(),
    });
    expect(hasReport(customerJob({ status: "disputed" }))).toBe(true);
    expect(hasReport(customerJob({ status: "paid_out", timeline: [moved("disputed")] }))).toBe(
      true,
    );
    expect(hasReport(customerJob({ status: "refunded", timeline: [moved("disputed")] }))).toBe(
      true,
    );
    expect(hasReport(customerJob({ status: "paid_out", timeline: [moved("completed")] }))).toBe(
      false,
    );
    expect(hasReport(customerJob({ status: "completed" }))).toBe(false);
  });
});

describe("ReportStatus", () => {
  it("shows an open report: reason, day and status, and that the team is on it", async () => {
    await render(<ReportStatus job={DISPUTED} />, { wrapper });
    await act(settle);
    expect(screen.getByText("Report sent")).toBeTruthy();
    expect(await screen.findByLabelText("The work isn't finished, Today, Open")).toBeTruthy();
    expect(screen.getByTestId("job-report-summary-outcome")).toHaveTextContent(
      "Our team is reviewing it and will contact you in the app.",
    );
  });

  it.each([
    ["released", "Our team reviewed the report and the payment for this job was completed."],
    [
      "partial_release",
      "Our team reviewed the report and part of your payment went back to your payment method.",
    ],
    [
      "refunded",
      "Our team reviewed the report and your payment for this job went back to your payment method.",
    ],
  ] as const)("words a %s resolution, and no amount", async (resolution, words) => {
    answer = respond({
      dispute: dispute({ status: "resolved", resolution, resolved_at: new Date().toISOString() }),
      can_report: false,
      report_by: null,
    });
    await render(<ReportStatus job={customerJob({ status: "paid_out" })} />, { wrapper });
    await act(settle);
    expect(await screen.findByLabelText("The work isn't finished, Today, Resolved")).toBeTruthy();
    expect(screen.getByTestId("job-report-summary-outcome")).toHaveTextContent(words);
    expect(screen.queryByText(/\$/)).toBeNull();
  });

  it("holds the place of its lines while loading, then fills them", async () => {
    const held = deferred<Response>();
    answer = () => held.promise;
    await render(<ReportStatus job={DISPUTED} />, { wrapper });
    expect(screen.getByTestId("job-report-loading")).toBeTruthy();
    await act(async () => {
      held.resolve(jsonResponse(200, { dispute: dispute(), can_report: false, report_by: null }));
      await settle();
    });
    expect(await screen.findByTestId("job-report-summary")).toBeTruthy();
  });

  it("says a failed read, and reads again on a tap", async () => {
    answer = () => Promise.resolve(errorResponse(503, "unavailable"));
    await render(<ReportStatus job={DISPUTED} />, { wrapper });
    await act(settle);
    expect(await screen.findByTestId("job-report-error")).toHaveTextContent(
      "We couldn't load your report. Try again",
    );
    answer = respond({ dispute: dispute(), can_report: false, report_by: null });
    const before = reads();
    await fireEvent.press(screen.getByTestId("job-report-error"));
    await waitFor(() => expect(reads()).toBe(before + 1));
    expect(await screen.findByTestId("job-report-summary")).toBeTruthy();
  });

  it("reads the report again when the job's status moves on under it", async () => {
    const rendered = await render(<ReportStatus job={DISPUTED} />, { wrapper });
    await act(settle);
    expect(await screen.findByLabelText("The work isn't finished, Today, Open")).toBeTruthy();
    answer = respond({
      dispute: dispute({
        status: "resolved",
        resolution: "refunded",
        resolved_at: new Date().toISOString(),
      }),
      can_report: false,
      report_by: null,
    });
    const before = reads();
    await rendered.rerender(<ReportStatus job={{ ...DISPUTED, status: "refunded" }} />);
    await waitFor(() => expect(reads()).toBe(before + 1));
    expect(await screen.findByLabelText("The work isn't finished, Today, Resolved")).toBeTruthy();
  });

  it("draws nothing when no report was made", async () => {
    answer = respond({ dispute: null, can_report: false, report_by: null });
    await render(<ReportStatus job={customerJob({ status: "paid_out" })} />, { wrapper });
    await act(settle);
    await waitFor(() => expect(screen.queryByTestId("job-report")).toBeNull());
  });
});

describe("Report a problem in the confirm dock", () => {
  const FINISHED = customerJob({ status: "completed" });
  const FINISHED_PATH = `/v1/jobs/${FINISHED.id}/dispute`;
  let push: jest.Mock;

  beforeEach(() => {
    push = jest.fn();
    fetchMock.mockImplementation(async (...call) =>
      callPath(call) === FINISHED_PATH ? answer() : errorResponse(404, "not_found"),
    );
  });

  const renderDock = async () => {
    await render(
      <ConfirmDock job={FINISHED} requestId={REQUEST_ID} updatedAt={Date.now()} push={push} />,
      { wrapper },
    );
    await act(settle);
  };
  const reportable = (msAhead: number) =>
    respond({
      dispute: null,
      can_report: true,
      report_by: new Date(Date.now() + msAhead).toISOString(),
    });

  it("offers it under Confirm while the API's window is open, into the report", async () => {
    answer = reportable(3_600_000);
    await renderDock();
    expect(screen.getByTestId("job-confirm")).toBeTruthy();
    await fireEvent.press(await screen.findByRole("button", { name: "Report a problem" }));
    expect(push).toHaveBeenCalledWith({
      pathname: "/requests/[id]/report",
      params: { id: REQUEST_ID },
    });
  });

  it("leaves it out when the API says no report can be made", async () => {
    answer = respond({ dispute: null, can_report: false, report_by: null });
    await renderDock();
    expect(screen.getByTestId("job-confirm")).toBeTruthy();
    expect(screen.queryByTestId("job-report-problem")).toBeNull();
  });

  it("leaves it out while the window is unknown: loading, or a failed read", async () => {
    const held = deferred<Response>();
    answer = () => held.promise;
    await renderDock();
    expect(screen.queryByTestId("job-report-problem")).toBeNull();
    await act(async () => {
      held.resolve(errorResponse(503, "unavailable"));
      await settle();
    });
    expect(screen.queryByTestId("job-report-problem")).toBeNull();
    expect(screen.getByTestId("job-confirm")).toBeTruthy();
  });

  it("takes it away when the API's deadline passes on screen", async () => {
    answer = reportable(1_500);
    await renderDock();
    expect(await screen.findByTestId("job-report-problem")).toBeTruthy();
    await waitFor(() => expect(screen.queryByTestId("job-report-problem")).toBeNull(), {
      timeout: 4_000,
    });
  });
});
