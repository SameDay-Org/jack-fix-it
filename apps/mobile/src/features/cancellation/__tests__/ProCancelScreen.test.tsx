import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { AccessibilityInfo } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { router } from "expo-router";

import i18n from "@/i18n";

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
import type { ProJob } from "../../pro-jobs/phase";
import { arrived, JOB_ID, onTheWay, proJob, working } from "../../pro-jobs/__tests__/helpers";
import type { ProCancellation } from "../api";
import { ProCancelScreen } from "../ProCancelScreen";

jest.mock(
  "../../../api/config",
  () => jest.requireActual("../../../api/__tests__/helpers").configMock,
);
jest.mock(
  "expo-secure-store",
  () => jest.requireActual("../../../api/__tests__/helpers").secureStoreMock,
);
// The route's params: a link can hand the mounted screen another job's.
const mockParams = { id: "00000000-0000-4000-8000-000000000630" };
jest.mock("expo-router", () => ({
  ...jest.requireActual("../../home/__tests__/helpers").homeRouterMock(),
  router: {
    push: jest.fn(),
    back: jest.fn(),
    canGoBack: jest.fn(() => true),
    replace: jest.fn(),
    dismissTo: jest.fn(),
  },
  useLocalSearchParams: () => ({ id: mockParams.id }),
}));
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);

type Answer = ReturnType<typeof deferred<Response>>;

const OTHER_JOB_ID = "00000000-0000-4000-8000-000000000699";
const JOB_PATH = `/v1/pros/me/jobs/${JOB_ID}`;
const CANCEL_PATH = `/v1/pros/me/jobs/${JOB_ID}/cancel`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STATEMENT =
  "Cancelling costs Maria nothing: their whole payment goes back to their payment method. You won't be paid for this job.";

const cancellation = (overrides: Partial<ProCancellation> = {}): ProCancellation => ({
  cancelled_by: "pro",
  reason_code: "cannot_make_it",
  cancelled_at: new Date().toISOString(),
  job_id: JOB_ID,
  job_status: "cancelled",
  ...overrides,
});
const cancelledJob = (by: ProCancellation["cancelled_by"] = "pro"): ProJob =>
  proJob({
    status: "cancelled",
    address: null,
    cancellation: {
      cancelled_by: by,
      reason_code: by === "pro" ? "cannot_make_it" : "changed_my_mind",
      cancelled_at: new Date().toISOString(),
    },
  });

let fetchMock: FetchMock;
let client: QueryClient;
/** What the job read answers: the job, or a refusal / failure as [status, code]. */
let job: ProJob | [number, string];
/** One entry per cancel the app sent; the test answers each. */
let posts: Answer[];

const isPost = (call: (typeof fetchMock.mock.calls)[number]) => call[1]?.method === "POST";
const postCalls = () =>
  fetchMock.mock.calls.filter((call) => callPath(call) === CANCEL_PATH && isPost(call));
const jobReads = () => fetchMock.mock.calls.filter((call) => callPath(call) === JOB_PATH).length;
const keyOf = (call: (typeof fetchMock.mock.calls)[number]) =>
  (call[1]?.headers as Record<string, string>)["Idempotency-Key"];

const wrapper = ({ children }: { children: ReactNode }) => (
  <SafeAreaProvider initialMetrics={METRICS}>
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  </SafeAreaProvider>
);

/** Renders the screen once the job has answered and been drawn. */
async function renderScreen() {
  const rendered = await render(<ProCancelScreen />, { wrapper });
  await waitFor(() => expect(screen.queryByTestId("cancel-loading")).toBeNull());
  await act(settle);
  return rendered;
}

const confirm = () => fireEvent.press(screen.getByTestId("cancel-confirm"));
const announced = () => jest.spyOn(AccessibilityInfo, "announceForAccessibilityWithOptions");
const pick = (reason = "I can't make it") =>
  fireEvent.press(screen.getByRole("radio", { name: reason }));

async function answer(index: number, response: Response | Error): Promise<void> {
  await waitFor(() => expect(posts.length).toBeGreaterThan(index));
  await act(async () => {
    if (response instanceof Error) posts[index]!.reject(response);
    else posts[index]!.resolve(response);
    await settle();
  });
}

beforeEach(async () => {
  mockParams.id = JOB_ID;
  posts = [];
  job = proJob();
  fetchMock = installFetchMock();
  fetchMock.mockImplementation(async (...call) => {
    const path = callPath(call);
    if (path === CANCEL_PATH && isPost(call)) {
      const post = deferred<Response>();
      posts.push(post);
      return post.promise;
    }
    if (path === JOB_PATH) {
      return Array.isArray(job) ? errorResponse(job[0], job[1]) : jsonResponse(200, job);
    }
    if (path === `/v1/pros/me/jobs/${OTHER_JOB_ID}`) {
      return jsonResponse(200, proJob({ id: OTHER_JOB_ID }));
    }
    return errorResponse(404, "not_found");
  });
  resetSecureStore();
  client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } });
  attachQueryClient(client);
  await i18n.changeLanguage("en");
  sessionStore.setState({
    ...SIGNED_OUT,
    status: "signedIn",
    user: { ...user, role: "pro" },
    accessToken: "access-1",
    accessTokenExpiresAt: Date.now() + 900_000,
  });
  jest.mocked(router.push).mockClear();
  jest.mocked(router.back).mockClear();
});

afterEach(async () => {
  await act(async () => {
    posts.forEach((post) => post.resolve(errorResponse(500, "internal_error")));
    await settle();
  });
  await i18n.changeLanguage("en");
});

describe("ProCancelScreen", () => {
  it("lists the pro's four reasons as radios, and says the customer is never charged", async () => {
    await renderScreen();
    expect(screen.getByText("Tell us why. We'll let Maria know.")).toBeTruthy();
    expect(screen.getAllByRole("radio").map((radio) => radio.props.accessibilityLabel)).toEqual([
      "I can't make it",
      "The customer isn't answering",
      "The job is different from what was asked",
      "Something else",
    ]);
    expect(screen.getByTestId("cancel-cost-statement")).toHaveTextContent(STATEMENT);
    // No amount on this side: the customer's money is the API's to give back.
    expect(screen.queryByText(/\$/)).toBeNull();
  });

  it.each([
    ["on the way", onTheWay()],
    ["arrived", arrived()],
    ["with the check-in locked", onTheWay({ arrival_code_locked: true })],
  ])("offers the cancel while the job is %s", async (_, current) => {
    job = current;
    await renderScreen();
    expect(screen.getByTestId("cancel-form")).toBeTruthy();
  });

  it("says a started job can't be cancelled, points to Talk to Jack, and sends nothing", async () => {
    job = working();
    await renderScreen();
    expect(screen.getByTestId("cancel-closed")).toBeTruthy();
    expect(screen.getByText("This job can't be cancelled now")).toBeTruthy();
    expect(screen.queryByTestId("cancel-confirm")).toBeNull();
    await fireEvent.press(screen.getByTestId("cancel-talk"));
    expect(router.push).toHaveBeenCalledWith("/help/contact");
    expect(postCalls()).toHaveLength(0);
  });

  it("asks for a reason first, at the field, and sends nothing", async () => {
    const announce = announced();
    await renderScreen();
    await confirm();
    expect(screen.getByTestId("cancel-reason-error")).toHaveTextContent(
      "Choose why you're cancelling.",
    );
    expect(announce).toHaveBeenLastCalledWith("Choose why you're cancelling.", { queue: true });
    expect(postCalls()).toHaveLength(0);
  });

  it("says by how much a note is too long, and holds the cancel", async () => {
    await renderScreen();
    await pick();
    await fireEvent.changeText(screen.getByTestId("cancel-note"), "a".repeat(501));
    expect(screen.getByText("This is 1 character too long.")).toBeTruthy();
    await confirm();
    expect(postCalls()).toHaveLength(0);
    await fireEvent.changeText(screen.getByTestId("cancel-note"), "a".repeat(500));
    await confirm();
    await waitFor(() => expect(postCalls()).toHaveLength(1));
  });

  it("cancels once on a double tap: the reason, the trimmed note and a key, never an amount", async () => {
    await renderScreen();
    await pick("The job is different from what was asked");
    await fireEvent.changeText(screen.getByTestId("cancel-note"), "  It needs a plumber.  ");
    await confirm();
    await confirm();
    await waitFor(() => expect(postCalls()).toHaveLength(1));
    const [call] = postCalls();
    expect(callBody(call!)).toEqual({ reason_code: "scope_changed", note: "It needs a plumber." });
    expect(keyOf(call!)).toMatch(UUID);
  });

  it("sends no note when none was written", async () => {
    await renderScreen();
    await pick("Something else");
    await confirm();
    await waitFor(() => expect(postCalls()).toHaveLength(1));
    expect(callBody(postCalls()[0]!)).toEqual({ reason_code: "other", note: null });
  });

  it.each([
    ["a lost connection", new TypeError("Network request failed"), /No connection/],
    ["a wait the API asked for (429)", errorResponse(429, "rate_limited"), /a lot of tries/],
    ["a failure on the API's side", errorResponse(500, "internal_error"), /didn't go through/],
  ])(
    "keeps the choice after %s, and goes again with the same key and body",
    async (_, failure, copy) => {
      await renderScreen();
      await pick();
      await confirm();
      await answer(0, failure);
      expect(screen.getByTestId("cancel-failure")).toHaveTextContent(copy);
      expect(screen.queryByText("rate_limited")).toBeNull();
      expect(screen.getByRole("radio", { name: "I can't make it" })).toBeChecked();
      expect(screen.getByTestId("cancel-confirm")).toHaveTextContent("Try again");
      await confirm();
      await waitFor(() => expect(postCalls()).toHaveLength(2));
      const [first, second] = postCalls();
      expect(keyOf(second!)).toBe(keyOf(first!));
      expect(callBody(second!)).toEqual(callBody(first!));
    },
  );

  it("says the job was cancelled and the customer told, reads the job again, and goes back", async () => {
    const announce = announced();
    await renderScreen();
    const before = jobReads();
    await pick();
    await confirm();
    job = cancelledJob();
    await answer(0, jsonResponse(200, cancellation()));
    expect(await screen.findByTestId("cancel-sent")).toBeTruthy();
    expect(screen.getByText("You cancelled this job")).toBeTruthy();
    expect(screen.getByText("We told Maria. They won't be charged for it.")).toBeTruthy();
    expect(announce).toHaveBeenCalledWith("You cancelled this job", { queue: true });
    await waitFor(() => expect(jobReads()).toBeGreaterThan(before));
    await fireEvent.press(screen.getByTestId("cancel-back"));
    expect(router.back).toHaveBeenCalled();
  });

  it("says so when the customer had cancelled first (the API answers with theirs)", async () => {
    await renderScreen();
    await pick();
    await confirm();
    job = cancelledJob("customer");
    await answer(0, jsonResponse(200, cancellation({ cancelled_by: "customer" })));
    expect(await screen.findByText("This job was cancelled")).toBeTruthy();
    expect(
      screen.getByText("It was cancelled by Maria. Nothing more is needed from you."),
    ).toBeTruthy();
    expect(screen.queryByText("You cancelled this job")).toBeNull();
  });

  it("opened on a job already cancelled, says who did it, with no form", async () => {
    job = { ...cancelledJob(), customer_first_name: null };
    await renderScreen();
    expect(screen.getByText("You cancelled this job")).toBeTruthy();
    expect(screen.getByText("We told your customer. They won't be charged for it.")).toBeTruthy();
    expect(screen.queryByTestId("cancel-confirm")).toBeNull();
  });

  it("reads the job again when the API says it moved on, and shows it as it is now", async () => {
    await renderScreen();
    const before = jobReads();
    await pick();
    await confirm();
    job = working();
    await answer(0, errorResponse(409, "cancel_not_allowed"));
    await waitFor(() => expect(jobReads()).toBeGreaterThan(before));
    expect(await screen.findByTestId("cancel-closed")).toBeTruthy();
    expect(screen.queryByText("cancel_not_allowed")).toBeNull();
  });

  it("a cancel the API holds for staff (needs review) says so, points to Jack, and stops", async () => {
    const announce = announced();
    await renderScreen();
    await pick();
    await confirm();
    await answer(0, errorResponse(409, "cancel_needs_review"));
    expect(await screen.findByText("We need to look at this job first")).toBeTruthy();
    expect(announce).toHaveBeenCalledWith(
      "We need to look at this job first. Something about its payment needs our team. Talk to Jack and we'll sort it out.",
      { queue: true },
    );
    expect(screen.getByTestId("cancel-talk")).toBeTruthy();
    expect(screen.queryByTestId("cancel-confirm")).toBeNull();
    expect(postCalls()).toHaveLength(1);
  });

  it("a note the API refuses (422) says to check it, without the API's words", async () => {
    await renderScreen();
    await pick();
    await confirm();
    await answer(0, errorResponse(422, "validation_error"));
    expect(screen.getByTestId("cancel-failure")).toHaveTextContent(/Check your note/);
    expect(screen.queryByText("validation_error")).toBeNull();
    expect(screen.getByTestId("cancel-confirm")).toHaveTextContent("Cancel the job");
  });

  it.each([
    [404, "not_found"],
    [403, "forbidden"],
  ])("a job that is not this pro's (%s) reads as not found", async (status, code) => {
    job = [status, code];
    await renderScreen();
    expect(screen.getByTestId("cancel-gone")).toBeTruthy();
    expect(screen.getByText("We couldn't find this job")).toBeTruthy();
    expect(screen.queryByTestId("cancel-confirm")).toBeNull();
  });

  it("says when the job could not load, and its retry reads it again", async () => {
    job = [503, "unavailable"];
    await renderScreen();
    expect(screen.getByTestId("cancel-load-failed")).toBeTruthy();
    expect(screen.queryByTestId("cancel-confirm")).toBeNull();
    job = proJob();
    await fireEvent.press(screen.getByTestId("cancel-retry"));
    expect(await screen.findByTestId("cancel-form")).toBeTruthy();
  });

  it("a link to another job's cancel opens a fresh form, never the cancel just sent", async () => {
    const rendered = await renderScreen();
    await pick();
    await confirm();
    job = cancelledJob();
    await answer(0, jsonResponse(200, cancellation()));
    expect(await screen.findByText("You cancelled this job")).toBeTruthy();
    mockParams.id = OTHER_JOB_ID;
    await rendered.rerender(<ProCancelScreen />);
    expect(await screen.findByTestId("cancel-form")).toBeTruthy();
    expect(screen.queryByText("You cancelled this job")).toBeNull();
    expect(screen.getByRole("radio", { name: "I can't make it" })).not.toBeChecked();
  });

  it("speaks Spanish too", async () => {
    await i18n.changeLanguage("es");
    await renderScreen();
    expect(screen.getAllByRole("radio").map((radio) => radio.props.accessibilityLabel)).toEqual([
      "No puedo ir",
      "El cliente no responde",
      "El trabajo es distinto de lo que se pidió",
      "Otra cosa",
    ]);
    expect(screen.getByTestId("cancel-cost-statement")).toHaveTextContent(
      "Cancelar no le cuesta nada a Maria: todo su pago vuelve a su método de pago. No recibirás pago por este trabajo.",
    );
  });
});
