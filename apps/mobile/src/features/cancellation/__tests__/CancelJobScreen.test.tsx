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
// The route's params: a link can hand the mounted screen another request's.
const mockParams = { id: "7c9e6679-7425-40de-944b-e07fc1f90ae7" };
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

const REQUEST_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const OTHER_REQUEST_ID = "0b9e5f8e-6a3c-4c1e-9d2f-1a2b3c4d5e6f";
const OTHER_JOB = customerJob({ id: "1c2d3e4f-0000-4000-8000-000000000999", status: "confirmed" });
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
/**
 * What the preview answers: the API's numbers, a refusal / failure as [status, code], or an error
 * the request throws (no connection).
 */
let preview: CancelPreview | [number, string] | Error;
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
const announced = () => jest.spyOn(AccessibilityInfo, "announceForAccessibilityWithOptions");
/** The job screen underneath reads the shared preview again (a status change, a retry). */
async function previewReadElsewhere(): Promise<void> {
  await act(async () => {
    await client.refetchQueries({ queryKey: ["cancel-preview"] });
    await settle();
  });
}
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
  mockParams.id = REQUEST_ID;
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
      if (preview instanceof Error) throw preview;
      return Array.isArray(preview)
        ? errorResponse(preview[0], preview[1])
        : jsonResponse(200, preview);
    }
    if (path === JOB_PATH) return jsonResponse(200, job);
    if (path === `/v1/requests/${OTHER_REQUEST_ID}/job`) return jsonResponse(200, OTHER_JOB);
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

  it("a cancel that finds the pro's, made first, says the pro cancelled, never that the customer did", async () => {
    const announce = announced();
    await renderScreen();
    await pick();
    await confirm();
    await answer(
      0,
      jsonResponse(
        200,
        cancellation({
          cancelled_by: "pro",
          reason_code: "cannot_make_it",
          fee_cents: 0,
          refund_cents: 18_050,
        }),
      ),
    );
    expect(await screen.findByText("Dan cancelled this job")).toBeTruthy();
    const support = "This costs you nothing. You can start a new request to find another pro.";
    expect(screen.getByText(support)).toBeTruthy();
    expect(
      screen.getByText("$180.50 is going back to your payment method. It's being processed."),
    ).toBeTruthy();
    expect(screen.queryByText("Your job was cancelled")).toBeNull();
    expect(screen.queryByText("Your pro was told.")).toBeNull();
    expect(announce).toHaveBeenCalledWith(`Dan cancelled this job. ${support}`, { queue: true });
  });

  it("a link to another job's cancel shows that job, never the cancel just sent", async () => {
    const rendered = await renderScreen();
    await pick();
    await confirm();
    await answer(0, jsonResponse(200, cancellation({ fee_cents: 0, refund_cents: 18_050 })));
    expect(await screen.findByText("Your job was cancelled")).toBeTruthy();
    // The same screen, new params: another request's job, confirmed.
    mockParams.id = OTHER_REQUEST_ID;
    await rendered.rerender(<CancelJobScreen />);
    expect(await screen.findByTestId("cancel-closed")).toBeTruthy();
    expect(screen.queryByText("Your job was cancelled")).toBeNull();
    expect(screen.queryByText(/going back to your payment method/)).toBeNull();
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

  it("says a job that can no longer be cancelled is closed, and points to Talk to John", async () => {
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

  it.each([
    ["an error answer", [503, "unavailable"] as [number, string]],
    ["no connection", new TypeError("Network request failed")],
  ])(
    "says when it could not load (%s) in its own words, and reads the job and the preview again on a tap",
    async (_, failure) => {
      preview = failure;
      await renderScreen();
      expect(await screen.findByTestId("cancel-load-failed")).toBeTruthy();
      expect(screen.getByText("We couldn't load this")).toBeTruthy();
      expect(screen.getByText("Check your connection and try again.")).toBeTruthy();
      expect(screen.queryByText("Give it a moment")).toBeNull();
      expect(screen.queryByTestId("cancel-confirm")).toBeNull();
      const jobs = jobReads();
      preview = FREE;
      await fireEvent.press(screen.getByTestId("cancel-retry"));
      expect(await screen.findByTestId("cancel-form")).toBeTruthy();
      expect(previewReads()).toBe(2);
      expect(jobReads()).toBe(jobs + 1);
    },
  );

  it("opened while the API asks to wait (429), says so calmly, offers no cancel, and reads again on a tap", async () => {
    const announce = announced();
    preview = [429, "rate_limited"];
    await renderScreen();
    expect(await screen.findByTestId("cancel-load-failed")).toBeTruthy();
    expect(screen.getByText("Give it a moment")).toBeTruthy();
    expect(
      screen.getByText("We can't show what cancelling costs right now. Try again shortly."),
    ).toBeTruthy();
    expect(announce).toHaveBeenCalledWith(
      "Give it a moment. We can't show what cancelling costs right now. Try again shortly.",
      { queue: true },
    );
    expect(screen.queryByTestId("cancel-form")).toBeNull();
    expect(screen.queryByTestId("cancel-confirm")).toBeNull();
    expect(screen.queryByText(/rate_limited|API request failed|Check your connection/)).toBeNull();
    preview = FREE;
    await fireEvent.press(screen.getByTestId("cancel-retry"));
    expect(await screen.findByTestId("cancel-form")).toBeTruthy();
    expect(previewReads()).toBe(2);
  });

  it("a cancel the API asks to wait for (429) keeps the choice, and goes again with the same Idempotency-Key", async () => {
    await renderScreen();
    await pick();
    await fireEvent.changeText(screen.getByTestId("cancel-note"), "Running two hours late.");
    expect(screen.getByTestId("cancel-confirm")).toHaveTextContent("Cancel the job");
    await confirm();
    const reads = previewReads();
    await answer(0, errorResponse(429, "rate_limited", { "Retry-After": "540" }));
    expect(screen.getByTestId("cancel-failure")).toHaveTextContent(
      /That's a lot of tries at once.*Nothing was cancelled, and your choice is still here\. Try again a little later\./,
    );
    expect(screen.queryByText(/rate_limited|API request failed|540/)).toBeNull();
    expect(screen.getByTestId("cancel-confirm")).toHaveTextContent("Try again");
    // The form stands as it was: nothing is read again, and the cost shown is the one agreed to.
    expect(screen.getByTestId("cancel-note").props.value).toBe("Running two hours late.");
    expect(screen.getByRole("radio", { name: "The pro is late" })).toBeChecked();
    expect(screen.getByTestId("cancel-cost-statement")).toHaveTextContent(
      "Cancelling is free: you'll get back the full $180.50.",
    );
    expect(previewReads()).toBe(reads);
    await confirm();
    await waitFor(() => expect(postCalls()).toHaveLength(2));
    const [first, second] = postCalls();
    expect(keyOf(first!)).toMatch(UUID);
    expect(keyOf(second!)).toBe(keyOf(first!));
    expect(callBody(second!)).toEqual(callBody(first!));
    expect(previewReads()).toBe(reads);
    await answer(1, jsonResponse(200, cancellation({ fee_cents: 0, refund_cents: 18_050 })));
    expect(await screen.findByText("Your job was cancelled")).toBeTruthy();
  });

  it("a cost that changes under the open form is said, and the cancel asks again before it goes", async () => {
    await renderScreen();
    await pick();
    await confirm();
    await answer(0, errorResponse(429, "rate_limited"));
    expect(screen.getByTestId("cancel-confirm")).toHaveTextContent("Try again");
    // While the customer waits, the pro sets off and the job screen reads the cost again.
    preview = FEE;
    await previewReadElsewhere();
    expect(screen.getByTestId("cancel-cost-statement")).toHaveTextContent(
      /^Cancelling now costs \$12\.34/,
    );
    expect(screen.getByTestId("cancel-failure")).toHaveTextContent(/The cost changed/);
    expect(screen.getByTestId("cancel-confirm")).toHaveTextContent("Cancel the job");
    await confirm();
    await waitFor(() => expect(postCalls()).toHaveLength(2));
    const [first, second] = postCalls();
    expect(callBody(second!)).toMatchObject({ expected_fee_cents: 1_234 });
    expect(keyOf(second!)).toBe(keyOf(first!));
  });

  it("a preview read that fails while the cancel is on its way leaves the form to the cancel's answer", async () => {
    await renderScreen();
    await pick();
    await confirm();
    await waitFor(() => expect(posts).toHaveLength(1));
    preview = [429, "rate_limited"];
    await previewReadElsewhere();
    expect(screen.getByTestId("cancel-form")).toBeTruthy();
    expect(screen.queryByTestId("cancel-load-failed")).toBeNull();
    await answer(0, jsonResponse(200, cancellation({ fee_cents: 0, refund_cents: 18_050 })));
    expect(await screen.findByText("Your job was cancelled")).toBeTruthy();
  });

  it("a cost read again that the API asks to wait for (429) closes the form until it answers", async () => {
    const announce = announced();
    await renderScreen();
    await pick();
    await confirm();
    // The pro set off between the preview and the tap; the cost is read again, and the API asks
    // to wait: the old cost (free) must not stand beside a cancel button.
    preview = [429, "rate_limited"];
    await answer(0, errorResponse(409, "cancel_fee_changed"));
    expect(await screen.findByText("Give it a moment")).toBeTruthy();
    expect(announce).toHaveBeenCalledWith(
      "Give it a moment. We can't show what cancelling costs right now. Try again shortly.",
      { queue: true },
    );
    expect(screen.queryByTestId("cancel-confirm")).toBeNull();
    expect(screen.queryByText(/Cancelling is free/)).toBeNull();
    // A later failure of another kind keeps it closed: the cost is still unknown.
    preview = new TypeError("Network request failed");
    await fireEvent.press(screen.getByTestId("cancel-retry"));
    expect(await screen.findByText("We couldn't load this")).toBeTruthy();
    expect(screen.queryByTestId("cancel-confirm")).toBeNull();
    expect(screen.queryByText(/Cancelling is free/)).toBeNull();
    preview = FEE;
    await fireEvent.press(screen.getByTestId("cancel-retry"));
    expect(await screen.findByText(/Cancelling now costs \$12\.34/)).toBeTruthy();
    expect(postCalls()).toHaveLength(1);
  });

  it("asks to wait in Spanish too", async () => {
    await i18n.changeLanguage("es");
    preview = [429, "rate_limited"];
    await renderScreen();
    expect(await screen.findByText("Espera un momento")).toBeTruthy();
    expect(
      screen.getByText(
        "Ahora no podemos mostrar cuánto cuesta cancelar. Inténtalo de nuevo en breve.",
      ),
    ).toBeTruthy();
    preview = FREE;
    await fireEvent.press(screen.getByTestId("cancel-retry"));
    await fireEvent.press(await screen.findByRole("radio", { name: "Otra cosa" }));
    await confirm();
    await answer(0, errorResponse(429, "rate_limited"));
    expect(screen.getByTestId("cancel-failure")).toHaveTextContent(
      /Son muchos intentos seguidos.*No se canceló nada y tu elección sigue aquí\. Inténtalo de nuevo un poco más tarde\./,
    );
    expect(screen.getByTestId("cancel-confirm")).toHaveTextContent("Reintentar");
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
