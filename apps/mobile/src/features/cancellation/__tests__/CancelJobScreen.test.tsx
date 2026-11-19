import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { AccessibilityInfo } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { router } from "expo-router";

import i18n from "@/i18n";
import type { CustomerJob } from "@/features/jobs/phase";

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
import type { CancelPreview, Cancellation } from "../api";
import { CancelJobScreen } from "../CancelJobScreen";

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

type Answer = ReturnType<typeof deferred<Response>>;

const REQUEST_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const SCHEDULED = customerJob({ status: "scheduled" });
const JOB_PATH = `/v1/requests/${REQUEST_ID}/job`;
const PREVIEW_PATH = `/v1/jobs/${SCHEDULED.id}/cancel-preview`;
const CANCEL_PATH = `/v1/jobs/${SCHEDULED.id}/cancel`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Before On my way: nothing kept. */
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
/** After On my way. The amounts are the API's: on purpose not 15% of anything the phone holds. */
const FEE: CancelPreview = {
  ...FREE,
  job_status: "on_the_way",
  fee_applies: true,
  customer_total_cents: 11_233,
  fee_cents: 1_234,
  refund_cents: 9_999,
};
const cancellation = (overrides: Partial<Cancellation> = {}): Cancellation => ({
  job_id: SCHEDULED.id,
  job_status: "cancelled",
  cancelled_by: "customer",
  reason_code: "pro_late",
  fee_cents: 1_234,
  refund_cents: 9_999,
  currency: "usd",
  refund_status: "pending",
  cancelled_at: new Date().toISOString(),
  ...overrides,
});

let fetchMock: FetchMock;
let client: QueryClient;
let job: CustomerJob;
/** What the preview answers: the API's numbers, or a refusal / failure as [status, code]. */
let preview: CancelPreview | [number, string];
/** One entry per cancel the app sent; the test answers each. */
let posts: Answer[];

const isPost = (call: (typeof fetchMock.mock.calls)[number]) => call[1]?.method === "POST";
const postCalls = () =>
  fetchMock.mock.calls.filter((call) => callPath(call) === CANCEL_PATH && isPost(call));
const previewReads = () =>
  fetchMock.mock.calls.filter((call) => callPath(call) === PREVIEW_PATH).length;
const jobReads = () => fetchMock.mock.calls.filter((call) => callPath(call) === JOB_PATH).length;
const keyOf = (call: (typeof fetchMock.mock.calls)[number]) =>
  (call[1]?.headers as Record<string, string>)["Idempotency-Key"];

const wrapper = ({ children }: { children: ReactNode }) => (
  <SafeAreaProvider initialMetrics={METRICS}>
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  </SafeAreaProvider>
);

/** Renders the screen once the job and then its preview have answered and been drawn. */
async function renderScreen() {
  const rendered = await render(<CancelJobScreen />, { wrapper });
  await waitFor(() => expect(screen.queryByTestId("cancel-loading")).toBeNull());
  await act(settle);
  return rendered;
}

const confirm = () => fireEvent.press(screen.getByTestId("cancel-confirm"));
const pick = (reason = "The pro is late") =>
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
  posts = [];
  job = SCHEDULED;
  preview = FREE;
  fetchMock = installFetchMock();
  fetchMock.mockImplementation(async (...call) => {
    const path = callPath(call);
    if (path === CANCEL_PATH && isPost(call)) {
      const post = deferred<Response>();
      posts.push(post);
      return post.promise;
    }
    if (path === PREVIEW_PATH) {
      return Array.isArray(preview)
        ? errorResponse(preview[0], preview[1])
        : jsonResponse(200, preview);
    }
    if (path === JOB_PATH) return jsonResponse(200, job);
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

describe("CancelJobScreen", () => {
  it("lists the four reasons as radios, and says cancelling is free in the API's numbers", async () => {
    await renderScreen();
    expect(screen.getAllByRole("radio").map((radio) => radio.props.accessibilityLabel)).toEqual([
      "I changed my mind",
      "I found another pro",
      "The pro is late",
      "Something else",
    ]);
    expect(await screen.findByTestId("cancel-cost-statement")).toHaveTextContent(
      "Cancelling is free: you'll get back the full $180.50.",
    );
  });

  it("says what cancelling costs once the pro is on the way, in the API's numbers only", async () => {
    preview = FEE;
    job = { ...SCHEDULED, status: "on_the_way" };
    await renderScreen();
    expect(await screen.findByTestId("cancel-cost-statement")).toHaveTextContent(
      "Cancelling now costs $12.34 (15% of the job price). You'll get back $99.99.",
    );
  });

  it("asks for a reason first, at the field, and sends nothing", async () => {
    const announce = jest.spyOn(AccessibilityInfo, "announceForAccessibilityWithOptions");
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

  it("cancels once on a double tap: the reason, the trimmed note, the preview's fee and a key", async () => {
    preview = FEE;
    job = { ...SCHEDULED, status: "on_the_way" };
    await renderScreen();
    await pick();
    await fireEvent.changeText(screen.getByTestId("cancel-note"), "  Running two hours late.  ");
    await confirm();
    await confirm();
    await waitFor(() => expect(postCalls()).toHaveLength(1));
    const [call] = postCalls();
    expect(callBody(call!)).toEqual({
      reason_code: "pro_late",
      note: "Running two hours late.",
      expected_fee_cents: 1_234,
    });
    expect(keyOf(call!)).toMatch(UUID);
  });

  it("sends no note when none was written", async () => {
    await renderScreen();
    await pick("I changed my mind");
    await confirm();
    await waitFor(() => expect(postCalls()).toHaveLength(1));
    expect(callBody(postCalls()[0]!)).toEqual({
      reason_code: "changed_my_mind",
      note: null,
      expected_fee_cents: 0,
    });
  });

  it("sends a retry after a lost connection with the same Idempotency-Key", async () => {
    await renderScreen();
    await pick();
    await confirm();
    await answer(0, new TypeError("Network request failed"));
    expect(screen.getByTestId("cancel-failure")).toHaveTextContent(/No connection/);
    expect(screen.getByText("Try again")).toBeTruthy();
    await confirm();
    await waitFor(() => expect(postCalls()).toHaveLength(2));
    const [first, second] = postCalls();
    expect(keyOf(second!)).toBe(keyOf(first!));
  });

  it("shows the cancellation, the cost and where the money stands, and reads the job again", async () => {
    preview = FEE;
    job = { ...SCHEDULED, status: "on_the_way" };
    await renderScreen();
    const before = jobReads();
    await pick();
    await confirm();
    await answer(0, jsonResponse(200, cancellation()));
    expect(await screen.findByTestId("cancel-sent")).toBeTruthy();
    expect(screen.getByText("Your job was cancelled")).toBeTruthy();
    expect(screen.getByText("Cancelling cost $12.34.")).toBeTruthy();
    expect(
      screen.getByText("$99.99 is going back to your payment method. It's being processed."),
    ).toBeTruthy();
    await waitFor(() => expect(jobReads()).toBeGreaterThan(before));
    await fireEvent.press(screen.getByTestId("cancel-back"));
    expect(router.back).toHaveBeenCalled();
  });

  it.each([
    ["succeeded", 0, ["$180.50 went back to your payment method."]],
    [
      "failed",
      1_234,
      [
        "Cancelling cost $12.34.",
        "$99.99 hasn't gone back to your payment method yet. Our team is looking into it and will contact you in the app.",
      ],
    ],
    ["none", 0, ["There was nothing to give back."]],
  ] as const)(
    "a job cancelled before shows where its money stands (%s), asking for no preview",
    async (status, fee, lines) => {
      job = {
        ...SCHEDULED,
        status: "cancelled",
        cancellation: {
          cancelled_by: "customer",
          reason_code: "changed_my_mind",
          cancelled_at: new Date().toISOString(),
          customer_total_cents: 18_050,
          fee_cents: fee,
          refund_cents: fee ? 9_999 : 18_050,
          refund_status: status,
        },
      };
      await renderScreen();
      expect(await screen.findByTestId("cancel-sent")).toBeTruthy();
      expect(screen.getByText("This job was cancelled")).toBeTruthy();
      for (const line of lines) expect(screen.getByText(line)).toBeTruthy();
      expect(previewReads()).toBe(0);
    },
  );

  it("reads a cost that changed since the preview again, and takes nothing unseen", async () => {
    await renderScreen();
    await pick();
    await confirm();
    // The pro set off between the preview and the tap: the API refuses, nothing is written.
    preview = FEE;
    await answer(0, errorResponse(409, "cancel_fee_changed"));
    expect(screen.getByTestId("cancel-failure")).toHaveTextContent(/The cost changed/);
    expect(await screen.findByText(/Cancelling now costs \$12\.34/)).toBeTruthy();
    await confirm();
    await waitFor(() => expect(postCalls()).toHaveLength(2));
    const [first, second] = postCalls();
    expect(callBody(second!)).toMatchObject({ expected_fee_cents: 1_234 });
    expect(keyOf(second!)).toBe(keyOf(first!));
  });

  it("says a job that can no longer be cancelled is closed, and points to Talk to Jack", async () => {
    await renderScreen();
    await pick();
    await confirm();
    preview = [409, "cancel_not_allowed"];
    await answer(0, errorResponse(409, "cancel_not_allowed"));
    expect(await screen.findByTestId("cancel-closed")).toBeTruthy();
    expect(screen.getByText("This job can't be cancelled now")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("cancel-talk"));
    expect(router.push).toHaveBeenCalledWith("/help/contact");
  });

  it.each([
    ["cancel_not_allowed", "This job can't be cancelled now"],
    ["cancel_needs_review", "We need to look at this job first"],
  ])(
    "opened on a job the API won't cancel (%s), says so and offers no form",
    async (code, title) => {
      preview = [409, code];
      await renderScreen();
      expect(await screen.findByText(title)).toBeTruthy();
      expect(screen.queryByTestId("cancel-form")).toBeNull();
      expect(screen.queryByTestId("cancel-confirm")).toBeNull();
    },
  );

  it("asks a started job for no preview and says it can't be cancelled", async () => {
    job = { ...SCHEDULED, status: "in_progress" };
    await renderScreen();
    expect(await screen.findByTestId("cancel-closed")).toBeTruthy();
    expect(previewReads()).toBe(0);
  });

  it.each([
    [errorResponse(422, "validation_error"), /Check your note/],
    [errorResponse(500, "internal_error"), /That didn't go through/],
  ])("explains a refusal calmly, never in the API's words", async (response, copy) => {
    await renderScreen();
    await pick();
    await confirm();
    await answer(0, response);
    expect(screen.getByTestId("cancel-failure")).toHaveTextContent(copy);
    expect(screen.queryByText(/validation_error|internal_error|API request failed/)).toBeNull();
  });

  it("says when it could not load, and reads the preview again on a tap", async () => {
    preview = [503, "unavailable"];
    await renderScreen();
    expect(await screen.findByTestId("cancel-load-failed")).toBeTruthy();
    expect(screen.queryByTestId("cancel-confirm")).toBeNull();
    preview = FREE;
    await fireEvent.press(screen.getByTestId("cancel-retry"));
    expect(await screen.findByTestId("cancel-form")).toBeTruthy();
    expect(previewReads()).toBe(2);
  });

  it("speaks Spanish", async () => {
    await i18n.changeLanguage("es");
    preview = FEE;
    job = { ...SCHEDULED, status: "on_the_way" };
    await renderScreen();
    expect(screen.getByText("¿Cancelar este trabajo?")).toBeTruthy();
    expect(screen.getByRole("radio", { name: "El profesional llega tarde" })).toBeTruthy();
    expect(await screen.findByTestId("cancel-cost-statement")).toHaveTextContent(
      /^Cancelar ahora cuesta .*12,34.* \(15\s?%.* del precio del trabajo\)\. Recibes de vuelta .*99,99.*\.$/,
    );
  });
});
