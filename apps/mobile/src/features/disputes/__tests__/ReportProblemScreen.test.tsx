import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { AccessibilityInfo } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { router } from "expo-router";

import i18n from "@/i18n";
import type { MediaItem } from "@/features/media";

import {
  callBody,
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
import { customerJob } from "../../jobs/__tests__/helpers";
import type { CustomerDispute, CustomerDisputeView } from "../api";
import { DEFAULT_PHOTO_MAX } from "../config";
import { ReportProblemScreen } from "../ReportProblemScreen";

jest.mock(
  "../../../api/config",
  () => jest.requireActual("../../../api/__tests__/helpers").configMock,
);
jest.mock(
  "expo-secure-store",
  () => jest.requireActual("../../../api/__tests__/helpers").secureStoreMock,
);
jest.mock("expo-router", () => ({
  ...jest.requireActual("../../home/__tests__/helpers").homeRouterMock(),
  router: {
    push: jest.fn(),
    back: jest.fn(),
    canGoBack: jest.fn(() => true),
    replace: jest.fn(),
    dismissTo: jest.fn(),
  },
  useLocalSearchParams: () => ({ id: "7c9e6679-7425-40de-944b-e07fc1f90ae7" }),
}));
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);
// The picker itself is the media feature's (its own tests); here, what the form asks of it and
// what it holds when Send is pressed.
const mockMedia = { items: [] as MediaItem[], keys: [] as string[], options: [] as unknown[] };
jest.mock("@/features/media", () => ({
  ...jest.requireActual("@/features/media"),
  MediaPicker: () => null,
  useMediaUpload: (options: unknown) => {
    mockMedia.options.push(options);
    return { items: mockMedia.items, keys: mockMedia.keys };
  },
}));

type Answer = ReturnType<typeof deferred<Response>>;

const REQUEST_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const JOB = customerJob({ status: "completed" });
const DISPUTE_PATH = `/v1/jobs/${JOB.id}/dispute`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const dispute = (overrides: Partial<CustomerDispute> = {}): CustomerDispute => ({
  id: "0f8fad5b-d9cb-469f-a165-70867728950e",
  reason_code: "poor_quality",
  description: "The new tiles are loose.",
  status: "open",
  resolution: null,
  created_at: new Date().toISOString(),
  resolved_at: null,
  photos: [],
  photos_pending: 0,
  ...overrides,
});
const open = (): CustomerDisputeView => ({
  dispute: null,
  can_report: true,
  report_by: new Date(Date.now() + 3_600_000).toISOString(),
});

let fetchMock: FetchMock;
let client: QueryClient;
/** What `GET /v1/jobs/{id}/dispute` answers. */
let view: CustomerDisputeView | "down";
/** One entry per report the app sent; the test answers each. */
let posts: Answer[];

const postCalls = () =>
  fetchMock.mock.calls.filter(
    (call) => callPath(call) === DISPUTE_PATH && call[1]?.method === "POST",
  );
const keyOf = (call: (typeof fetchMock.mock.calls)[number]) =>
  (call[1]?.headers as Record<string, string>)["Idempotency-Key"];
const reads = () =>
  fetchMock.mock.calls.filter(
    (call) => callPath(call) === DISPUTE_PATH && call[1]?.method !== "POST",
  ).length;

const wrapper = ({ children }: { children: ReactNode }) => (
  <SafeAreaProvider initialMetrics={METRICS}>
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  </SafeAreaProvider>
);

/** Renders the screen once the job and then its report have answered. */
async function renderScreen() {
  const rendered = await render(<ReportProblemScreen />, { wrapper });
  await waitFor(() => expect(screen.queryByTestId("report-loading")).toBeNull());
  await act(settle);
  return rendered;
}

async function fill(reason = "The work isn't done well", text = "  The new tiles are loose.  ") {
  await fireEvent.press(screen.getByRole("radio", { name: reason }));
  await fireEvent.changeText(screen.getByTestId("report-description"), text);
}

const send = () => fireEvent.press(screen.getByTestId("report-send"));

async function answer(index: number, response: Response | Error): Promise<void> {
  await waitFor(() => expect(posts.length).toBeGreaterThan(index));
  await act(async () => {
    if (response instanceof Error) posts[index]!.reject(response);
    else posts[index]!.resolve(response);
    await settle();
  });
}

beforeEach(async () => {
  posts = [];
  view = open();
  mockMedia.items = [];
  mockMedia.keys = [];
  mockMedia.options = [];
  fetchMock = installFetchMock();
  fetchMock.mockImplementation(async (...call) => {
    const path = callPath(call);
    if (path === DISPUTE_PATH && call[1]?.method === "POST") {
      const post = deferred<Response>();
      posts.push(post);
      return post.promise;
    }
    if (path === DISPUTE_PATH) {
      return view === "down" ? errorResponse(503, "unavailable") : jsonResponse(200, view);
    }
    if (path === `/v1/requests/${REQUEST_ID}/job`) return jsonResponse(200, JOB);
    return errorResponse(404, "not_found");
  });
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
  jest.mocked(router.push).mockClear();
});

afterEach(async () => {
  await act(async () => {
    posts.forEach((post) => post.resolve(errorResponse(500, "internal_error")));
    await settle();
  });
  await i18n.changeLanguage("en");
});

describe("ReportProblemScreen", () => {
  it("lists the five reasons as radios and takes photos for a dispute, up to the max", async () => {
    await renderScreen();
    expect(screen.getAllByRole("radio").map((radio) => radio.props.accessibilityLabel)).toEqual([
      "The work isn't finished",
      "The work isn't done well",
      "The pro didn't show up",
      "Something was damaged",
      "Something else",
    ]);
    expect(mockMedia.options[0]).toEqual({ purpose: "dispute_photo", max: DEFAULT_PHOTO_MAX });
  });

  it("asks for a reason and a description at the fields, and sends nothing", async () => {
    const announce = jest.spyOn(AccessibilityInfo, "announceForAccessibilityWithOptions");
    await renderScreen();
    await send();
    expect(screen.getByTestId("report-reason-error")).toHaveTextContent("Choose what went wrong.");
    // The form brings the first missing field into view and says what it needs.
    expect(announce).toHaveBeenLastCalledWith("Choose what went wrong.", { queue: true });
    expect(screen.getByText("Describe the problem.")).toBeTruthy();
    // Spaces alone are no description.
    await fireEvent.press(screen.getByRole("radio", { name: "Something else" }));
    await fireEvent.changeText(screen.getByTestId("report-description"), "   ");
    await send();
    expect(screen.getByText("Describe the problem.")).toBeTruthy();
    expect(announce).toHaveBeenLastCalledWith("Describe the problem.", { queue: true });
    expect(postCalls()).toHaveLength(0);
  });

  it("says by how much a description is too long, and holds Send", async () => {
    await renderScreen();
    await fill("Something else", "a".repeat(2001));
    expect(screen.getByText("This is 1 character too long.")).toBeTruthy();
    expect(screen.getByText("2,001 / 2,000")).toBeTruthy();
    await send();
    expect(postCalls()).toHaveLength(0);
    await fireEvent.changeText(screen.getByTestId("report-description"), "a".repeat(2000));
    await send();
    await waitFor(() => expect(postCalls()).toHaveLength(1));
  });

  it("sends one report on a double tap, with the trimmed text, the photos and a key", async () => {
    mockMedia.keys = ["u/dispute/one.jpg", "u/dispute/two.jpg"];
    await renderScreen();
    await fill();
    await send();
    await send();
    await waitFor(() => expect(postCalls()).toHaveLength(1));
    const [call] = postCalls();
    expect(callBody(call!)).toEqual({
      reason_code: "poor_quality",
      description: "The new tiles are loose.",
      photo_keys: ["u/dispute/one.jpg", "u/dispute/two.jpg"],
    });
    expect(keyOf(call!)).toMatch(UUID);
  });

  it("sends a retry after a lost connection with the same Idempotency-Key", async () => {
    await renderScreen();
    await fill();
    await send();
    await answer(0, new TypeError("Network request failed"));
    expect(screen.getByTestId("report-failure")).toHaveTextContent(/No connection/);
    // The form keeps what was written; Send reads Try again.
    expect(screen.getByDisplayValue("  The new tiles are loose.  ")).toBeTruthy();
    expect(screen.getByText("Try again")).toBeTruthy();
    await send();
    await waitFor(() => expect(postCalls()).toHaveLength(2));
    const [first, second] = postCalls();
    expect(keyOf(second!)).toBe(keyOf(first!));
  });

  it("thanks the customer once the report is in, shows it, and asks for the job again", async () => {
    await renderScreen();
    const jobReads = () =>
      fetchMock.mock.calls.filter((call) => callPath(call) === `/v1/requests/${REQUEST_ID}/job`)
        .length;
    const before = jobReads();
    await fill();
    await send();
    await answer(0, jsonResponse(201, { dispute: dispute(), can_report: false, report_by: null }));
    // The answer lands in the cache; the screen draws it on the next notify tick.
    expect(await screen.findByTestId("report-sent")).toBeTruthy();
    expect(screen.getByText("We got your report")).toBeTruthy();
    expect(
      screen.getByText(
        "Our team reviews it and contacts you in the app. The payment for this job waits for that review.",
      ),
    ).toBeTruthy();
    expect(screen.getByLabelText("The work isn't done well, Today, Open")).toBeTruthy();
    await waitFor(() => expect(jobReads()).toBeGreaterThan(before));
    await fireEvent.press(screen.getByTestId("report-back"));
    expect(router.back).toHaveBeenCalled();
  });

  it("shows a report made before instead of the form", async () => {
    view = { dispute: dispute({ reason_code: "damage" }), can_report: false, report_by: null };
    await renderScreen();
    expect(screen.queryByTestId("report-form")).toBeNull();
    expect(screen.getByText("You reported a problem")).toBeTruthy();
    expect(screen.getByLabelText("Something was damaged, Today, Open")).toBeTruthy();
  });

  it("says reporting is closed when the API says so, and points to Talk to John", async () => {
    view = { dispute: null, can_report: false, report_by: null };
    await renderScreen();
    expect(screen.getByText("Reporting is closed for this job")).toBeTruthy();
    expect(screen.queryByTestId("report-form")).toBeNull();
    await fireEvent.press(screen.getByTestId("report-talk"));
    expect(router.push).toHaveBeenCalledWith("/help/contact");
  });

  it("reads the report again after a 409 and shows where it stands", async () => {
    await renderScreen();
    await fill();
    await send();
    const before = reads();
    view = { dispute: null, can_report: false, report_by: null };
    await answer(0, errorResponse(409, "job_not_disputable"));
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
    expect(await screen.findByText("Reporting is closed for this job")).toBeTruthy();
    // The API's own message never reaches the screen.
    expect(screen.queryByText(/can no longer be reported/)).toBeNull();
  });

  it("shows a report the same key already made after a 409, as sent", async () => {
    await renderScreen();
    await fill();
    await send();
    view = { dispute: dispute(), can_report: false, report_by: null };
    await answer(0, errorResponse(409, "idempotency_key_reused"));
    await waitFor(() => expect(screen.getByText("You reported a problem")).toBeTruthy());
  });

  it("explains a 422 calmly and keeps the form", async () => {
    await renderScreen();
    await fill();
    await send();
    await answer(0, errorResponse(422, "validation_error"));
    expect(screen.getByTestId("report-failure")).toHaveTextContent(/Check what you wrote/);
    expect(screen.getByTestId("report-form")).toBeTruthy();
  });

  it("waits for photos still uploading, and for a failed one to be retried or removed", async () => {
    const item = (status: MediaItem["status"]): MediaItem => ({
      id: status,
      kind: "image",
      previewUri: "file:///photo.jpg",
      status,
      progress: 0.5,
      key: null,
      failure: status === "failed" ? "failed" : null,
    });
    mockMedia.items = [item("uploading")];
    const rendered = await renderScreen();
    await fill();
    await send();
    expect(screen.getByTestId("report-photos-held")).toHaveTextContent(
      "Your photos are still uploading. Send once they're done.",
    );
    mockMedia.items = [item("failed")];
    await rendered.rerender(<ReportProblemScreen />);
    await send();
    expect(screen.getByTestId("report-photos-held")).toHaveTextContent(/didn't upload/);
    expect(postCalls()).toHaveLength(0);
  });

  it("says when the report could not load, and tries again", async () => {
    view = "down";
    await renderScreen();
    expect(screen.getByText("We couldn't load this job")).toBeTruthy();
    view = open();
    await fireEvent.press(screen.getByTestId("report-retry"));
    await waitFor(() => expect(screen.getByTestId("report-form")).toBeTruthy());
  });

  it("speaks Spanish", async () => {
    await i18n.changeLanguage("es");
    await renderScreen();
    expect(screen.getByText("Reportar un problema")).toBeTruthy();
    expect(screen.getByRole("radio", { name: "El profesional no se presentó" })).toBeTruthy();
    expect(screen.getByText("Enviar reporte")).toBeTruthy();
  });
});
