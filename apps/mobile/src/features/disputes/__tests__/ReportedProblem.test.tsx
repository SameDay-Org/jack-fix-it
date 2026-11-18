import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

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
import type { ProDispute, ProDisputeView } from "../api";
import { ReportedProblem } from "../ReportedProblem";

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

type Answer = ReturnType<typeof deferred<Response>>;

const JOB_ID = "6f1c2a40-0000-4000-8000-000000000660";
const DISPUTE_PATH = `/v1/pros/me/jobs/${JOB_ID}/dispute`;
const REPLY_PATH = `${DISPUTE_PATH}/reply`;
const later = new Date(Date.now() + 600_000).toISOString();
const SAFE_1 = "https://storage.example/m/0f8fad5bd9cb469fa16570867728950e.jpg?sig=1";
const SAFE_2 = "https://storage.example/m/1f8fad5bd9cb469fa16570867728950e.jpg?sig=2";

const dispute = (overrides: Partial<ProDispute> = {}): ProDispute => ({
  id: "0f8fad5b-d9cb-469f-a165-70867728950e",
  reason_code: "poor_quality",
  description: "The new tiles are loose. Call me at [phone removed].",
  status: "open",
  resolution: null,
  created_at: new Date().toISOString(),
  resolved_at: null,
  photos: [
    { id: "a1", content_type: "image/jpeg", url: SAFE_1, expires_at: later },
    { id: "a2", content_type: "image/jpeg", url: SAFE_2, expires_at: later },
  ],
  photos_pending: 1,
  reply: null,
  replied_at: null,
  ...overrides,
});

let fetchMock: FetchMock;
let client: QueryClient;
/** What `GET .../dispute` answers. */
let view: ProDisputeView | "down";
/** One entry per reply the app sent; the test answers each. */
let replies: Answer[];

const replyCalls = () => fetchMock.mock.calls.filter((call) => callPath(call) === REPLY_PATH);
const reads = () => fetchMock.mock.calls.filter((call) => callPath(call) === DISPUTE_PATH).length;

const wrapper = ({ children }: { children: ReactNode }) => (
  <SafeAreaProvider initialMetrics={METRICS}>
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  </SafeAreaProvider>
);

/** Renders the block once its read has answered and been drawn (a notify tick after the cache). */
async function renderBlock() {
  await render(<ReportedProblem jobId={JOB_ID} />, { wrapper });
  await waitFor(() => expect(screen.queryByTestId("pro-job-report-loading")).toBeNull());
  await act(settle);
}

const field = () => screen.getByTestId("pro-job-report-reply-input");
const send = () => fireEvent.press(screen.getByTestId("pro-job-report-reply-send"));

async function answer(index: number, response: Response | Error): Promise<void> {
  await waitFor(() => expect(replies.length).toBeGreaterThan(index));
  await act(async () => {
    if (response instanceof Error) replies[index]!.reject(response);
    else replies[index]!.resolve(response);
    await settle();
  });
}

beforeEach(async () => {
  replies = [];
  view = { dispute: dispute(), can_reply: true };
  fetchMock = installFetchMock();
  fetchMock.mockImplementation(async (...call) => {
    const path = callPath(call);
    if (path === REPLY_PATH) {
      const reply = deferred<Response>();
      replies.push(reply);
      return reply.promise;
    }
    if (path === DISPUTE_PATH) {
      return view === "down" ? errorResponse(503, "unavailable") : jsonResponse(200, view);
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
});

afterEach(async () => {
  await act(async () => {
    replies.forEach((reply) => reply.resolve(errorResponse(500, "internal_error")));
    await settle();
  });
  await i18n.changeLanguage("en");
});

describe("ReportedProblem", () => {
  it("shows the customer's report: reason, day, status, the masked words, and both sides' review", async () => {
    await renderBlock();
    expect(screen.getByText("The customer reported a problem")).toBeTruthy();
    expect(screen.getByText("Our team will review both sides.")).toBeTruthy();
    expect(screen.getByLabelText("The work isn't done well, Today, Open")).toBeTruthy();
    expect(screen.getByTestId("pro-job-report-description")).toHaveTextContent(
      "The new tiles are loose. Call me at [phone removed].",
    );
  });

  it("shows the photos' safe copies only, each named, and counts the ones still being prepared", async () => {
    await renderBlock();
    const uri = (index: number) =>
      screen.getByTestId(`pro-job-report-photos-${index}-image`).props.source;
    expect([uri(0), uri(1)]).toEqual([
      expect.objectContaining({ uri: SAFE_1 }),
      expect.objectContaining({ uri: SAFE_2 }),
    ]);
    expect(screen.getByLabelText("Customer's photo 1 of 2")).toBeTruthy();
    expect(screen.getByLabelText("Customer's photo 2 of 2")).toBeTruthy();
    expect(screen.getByTestId("pro-job-report-pending")).toHaveTextContent(
      "1 more photo is being prepared.",
    );
  });

  it("sends one reply, trimmed, then shows it read-only", async () => {
    await renderBlock();
    await fireEvent.changeText(field(), "  The tiles were set with the customer's adhesive.  ");
    await send();
    await waitFor(() => expect(replyCalls()).toHaveLength(1));
    expect(callBody(replyCalls()[0]!)).toEqual({
      message: "The tiles were set with the customer's adhesive.",
    });
    await answer(
      0,
      jsonResponse(200, {
        dispute: dispute({
          reply: "The tiles were set with the customer's adhesive.",
          replied_at: new Date().toISOString(),
        }),
        can_reply: false,
      }),
    );
    // The answer lands in the cache; the block draws it on the next notify tick.
    expect(await screen.findByTestId("pro-job-report-reply-sent")).toHaveTextContent(
      /Your reply.*The tiles were set with the customer's adhesive\./,
    );
    expect(screen.queryByTestId("pro-job-report-reply-input")).toBeNull();
    expect(screen.queryByTestId("pro-job-report-reply-send")).toBeNull();
  });

  it("asks for words before sending, and says by how much a reply is too long", async () => {
    await renderBlock();
    await send();
    expect(screen.getByText("Write your reply.")).toBeTruthy();
    await fireEvent.changeText(field(), "a".repeat(1001));
    expect(screen.getByText("This is 1 character too long.")).toBeTruthy();
    await send();
    expect(replyCalls()).toHaveLength(0);
  });

  it("keeps the words after a lost connection, and says so calmly", async () => {
    await renderBlock();
    await fireEvent.changeText(field(), "I finished every tile.");
    await send();
    await answer(0, new TypeError("Network request failed"));
    expect(screen.getByTestId("pro-job-report-reply-failure")).toHaveTextContent(/No connection/);
    expect(screen.getByDisplayValue("I finished every tile.")).toBeTruthy();
  });

  it("reads the report again after a 409 and shows the reply already given", async () => {
    await renderBlock();
    await fireEvent.changeText(field(), "Another answer.");
    await send();
    view = {
      dispute: dispute({ reply: "The first answer.", replied_at: new Date().toISOString() }),
      can_reply: false,
    };
    const before = reads();
    await answer(0, errorResponse(409, "already_replied"));
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
    expect(await screen.findByTestId("pro-job-report-reply-sent")).toHaveTextContent(
      /The first answer\./,
    );
    expect(screen.queryByText(/already replied/)).toBeNull();
  });

  it("offers no box once the report is resolved without a reply", async () => {
    view = {
      dispute: dispute({ status: "resolved", resolution: "released", resolved_at: later }),
      can_reply: false,
    };
    await renderBlock();
    expect(screen.getByLabelText("The work isn't done well, Today, Resolved")).toBeTruthy();
    expect(screen.queryByTestId("pro-job-report-reply")).toBeNull();
    expect(screen.queryByTestId("pro-job-report-reply-sent")).toBeNull();
  });

  it("says a failed read, and reads again on a tap", async () => {
    view = "down";
    await renderBlock();
    expect(screen.getByTestId("pro-job-report-error")).toHaveTextContent(
      "We couldn't load the report. Try again",
    );
    view = { dispute: dispute(), can_reply: true };
    await fireEvent.press(screen.getByTestId("pro-job-report-error"));
    expect(await screen.findByTestId("pro-job-report-description")).toBeTruthy();
  });

  it("speaks Spanish", async () => {
    await i18n.changeLanguage("es");
    await renderBlock();
    expect(screen.getByText("El cliente reportó un problema")).toBeTruthy();
    expect(screen.getByText("Nuestro equipo revisará ambas partes.")).toBeTruthy();
    expect(screen.getByText("Enviar respuesta")).toBeTruthy();
  });
});
