import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react-native";
import type { ApiSchema } from "@jack/shared";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { ApiError, logout, NetworkError, SessionExpiredError } from "@/api";
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
import { customerJob } from "../../jobs/__tests__/helpers";
import { MESSAGE_MAX, sendFailureOf } from "../api";
import { ContactScreen } from "../ContactScreen";
import { forgetForm, updateDraft } from "../draft";
import { useContactForm } from "../useContactForm";

jest.mock(
  "../../../api/config",
  () => jest.requireActual("../../../api/__tests__/helpers").configMock,
);
jest.mock(
  "expo-secure-store",
  () => jest.requireActual("../../../api/__tests__/helpers").secureStoreMock,
);
// A screen rendered on its own: focused, nothing navigating (the job hooks read the focus).
jest.mock("expo-router", () => ({
  ...jest.requireActual("../../home/__tests__/helpers").homeRouterMock(),
  router: { push: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true), replace: jest.fn() },
}));
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);

type Answer = ReturnType<typeof deferred<Response>>;

// Words no other string on the screen holds, so a leak of the message is easy to spot.
const MESSAGE = "  The plumber left zanahoria-7 under the sink.  ";
const REQUEST_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const JOB = customerJob({ status: "in_progress" });

let fetchMock: FetchMock;
let client: QueryClient;
/** One entry per `POST /v1/support/tickets` the app sent, in order; the test answers each. */
let posts: Answer[];
/** What `GET /v1/support/tickets/mine` answers. */
let mine: ServerTicket[] | "down";
/** Whether the customer has a job under way. */
let hasJob: boolean;

// A ticket as the API may answer it, text included: the app must keep none of it.
type ServerTicket = ApiSchema<"MySupportTicketOut">;

const ticket = (overrides: Partial<ServerTicket> = {}): ServerTicket => ({
  id: "0f8fad5b-d9cb-469f-a165-70867728950e",
  topic: "payment",
  message: MESSAGE,
  job_id: null,
  status: "open",
  created_at: new Date().toISOString(),
  closed_at: null,
  ...overrides,
});

const postCalls = () =>
  fetchMock.mock.calls.filter(
    (call) => callPath(call) === "/v1/support/tickets" && call[1]?.method === "POST",
  );
const created = (id = ticket().id) =>
  jsonResponse(201, { id, status: "open", created_at: new Date().toISOString() });
const offline = (answer: Answer) => answer.reject(new TypeError("Network request failed"));

const field = () => screen.getByTestId("contact-message");
const sendButton = () => screen.getByTestId("contact-send");
const topic = (name: string) => screen.getByRole("radio", { name });
const failure = () => screen.queryByTestId("contact-failure");

function signIn(): void {
  sessionStore.setState({
    ...SIGNED_OUT,
    status: "signedIn",
    user,
    accessToken: "access-1",
    accessTokenExpiresAt: Date.now() + 900_000,
  });
}

const wrapper = ({ children }: { children: ReactNode }) => (
  <SafeAreaProvider initialMetrics={METRICS}>
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  </SafeAreaProvider>
);

async function renderForm() {
  const view = await render(<ContactScreen />, { wrapper });
  // The job list and the person's messages have answered.
  await act(settle);
  return view;
}

async function write(text = MESSAGE, about = "A payment"): Promise<void> {
  await fireEvent.press(topic(about));
  await fireEvent.changeText(field(), text);
}

/** Settles the message the app sent `index`-th, and lets what follows from it happen. */
async function answer(index: number, settleWith: (post: Answer) => void): Promise<void> {
  await waitFor(() => expect(posts.length).toBeGreaterThan(index));
  await act(async () => {
    settleWith(posts[index]!);
    await settle();
  });
}

beforeEach(async () => {
  posts = [];
  mine = [];
  hasJob = false;
  fetchMock = installFetchMock();
  fetchMock.mockImplementation(async (...call) => {
    const path = callPath(call);
    if (path === "/v1/support/tickets" && call[1]?.method === "POST") {
      const post = deferred<Response>();
      posts.push(post);
      return post.promise;
    }
    if (path === "/v1/support/tickets/mine") {
      return mine === "down"
        ? errorResponse(503, "unavailable")
        : jsonResponse(200, { items: mine, next_cursor: null });
    }
    if (path === "/v1/requests") {
      const items = hasJob ? [{ id: REQUEST_ID, status: "accepted" }] : [];
      return jsonResponse(200, { items, next_cursor: null });
    }
    if (path === `/v1/requests/${REQUEST_ID}/job`) return jsonResponse(200, JOB);
    if (path === "/v1/auth/logout") return jsonResponse(204);
    return errorResponse(404, "not_found");
  });
  resetSecureStore();
  forgetForm();
  // Nothing in the cache expires: a garbage-collection timer would outlive the test.
  client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } });
  attachQueryClient(client);
  await i18n.changeLanguage("en");
  signIn();
});

afterEach(async () => {
  // No request is left without an answer: its timeout would keep the test run alive.
  await act(async () => {
    posts.forEach((post) => post.resolve(errorResponse(500, "internal_error")));
    await settle();
  });
  await i18n.changeLanguage("en");
});

describe("Talk to Jack: the form", () => {
  it("offers the six topics as radios and waits for a topic and some text before Send", async () => {
    await renderForm();

    expect(screen.getByRole("header", { name: "Talk to Jack" })).toBeOnTheScreen();
    expect(screen.getAllByRole("radio").map((chip) => chip.props.accessibilityLabel)).toEqual([
      "My account",
      "A payment",
      "A job",
      "Safety",
      "The app",
      "Something else",
    ]);
    expect(sendButton()).toBeDisabled();

    await fireEvent.changeText(field(), "Hello");
    expect(sendButton()).toBeDisabled(); // no topic yet

    await fireEvent.press(topic("Safety"));
    expect(topic("Safety")).toBeChecked();
    expect(sendButton()).toBeEnabled();

    await fireEvent.changeText(field(), "   \n ");
    expect(sendButton()).toBeDisabled(); // only spaces
  });

  it("counts near the limit, and past it says by how much without cutting the text", async () => {
    await renderForm();
    await fireEvent.press(topic("The app"));

    await fireEvent.changeText(field(), "a".repeat(1700));
    expect(screen.queryByText(/\/ 2,000/)).toBeNull();

    await fireEvent.changeText(field(), "a".repeat(1900));
    expect(screen.getByText("1,900 / 2,000")).toBeOnTheScreen();
    expect(sendButton()).toBeEnabled();

    await fireEvent.changeText(field(), "a".repeat(MESSAGE_MAX + 1));
    expect(screen.getByText("Your message is 1 character too long.")).toBeOnTheScreen();
    expect(sendButton()).toBeDisabled();

    const long = "a".repeat(MESSAGE_MAX + 250);
    await fireEvent.changeText(field(), long);
    expect(screen.getByText("Your message is 250 characters too long.")).toBeOnTheScreen();
    expect(field().props.value).toBe(long);
    expect(field().props.maxLength).toBeUndefined();
    expect(postCalls()).toHaveLength(0);
  });

  it("asks about a job only when the person has one", async () => {
    await renderForm();
    expect(screen.queryByTestId("contact-jobs")).toBeNull();
  });

  it("offers the job under way, not chosen until the person says so", async () => {
    hasJob = true;
    await renderForm();

    expect(topic("Not about a job")).toBeChecked();
    expect(topic("My job with Dan K.")).not.toBeChecked();

    await fireEvent.press(topic("My job with Dan K."));
    expect(topic("My job with Dan K.")).toBeChecked();
  });

  it("reads in Spanish", async () => {
    await i18n.changeLanguage("es");
    mine = [ticket({ status: "in_progress" })];
    await renderForm();

    expect(screen.getByRole("header", { name: "Habla con Jack" })).toBeOnTheScreen();
    expect(topic("Un pago")).toBeOnTheScreen();
    expect(screen.getByRole("button", { name: "Enviar mensaje" })).toBeDisabled();
    expect(screen.getByRole("header", { name: "Tus mensajes" })).toBeOnTheScreen();
    expect(screen.getByTestId(`contact-ticket-${ticket().id}`)).toHaveTextContent(
      "Un pagoHoyEn curso",
    );
  });
});

describe("Talk to Jack: sending", () => {
  it("sends the message as typed, once, then confirms and lists it", async () => {
    await renderForm();
    await write();

    await fireEvent.press(sendButton());

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(sendButton()).toBeBusy();
    const body = callBody(postCalls()[0]!) as Record<string, unknown>;
    expect(body).toMatchObject({
      topic: "payment",
      message: MESSAGE, // spaces and all
      job_id: null,
      platform: expect.stringMatching(/^(ios|android)$/),
    });
    // The app's version when the build has one (none under Jest); nothing else goes.
    expect(Object.keys(body).sort()).toEqual([
      "app_version",
      "job_id",
      "message",
      "platform",
      "topic",
    ]);

    mine = [ticket()];
    await answer(0, (post) => post.resolve(created()));

    await waitFor(() => expect(screen.getByTestId("contact-sent")).toBeOnTheScreen());
    expect(screen.getByTestId("contact-sent")).toHaveTextContent(/^We got your message/);
    expect(screen.queryByTestId("contact-send")).toBeNull();
    expect(screen.getByRole("header", { name: "Your messages" })).toBeOnTheScreen();
    expect(screen.getByTestId(`contact-ticket-${ticket().id}`)).toHaveTextContent(
      "A paymentTodayOpen",
    );
    expect(postCalls()).toHaveLength(1);

    // Another message starts from an empty form.
    await fireEvent.press(screen.getByRole("button", { name: "Write another message" }));
    expect(field().props.value).toBe("");
    expect(sendButton()).toBeDisabled();
  });

  it("sends the chosen job with the message", async () => {
    hasJob = true;
    await renderForm();
    await write();
    await fireEvent.press(topic("My job with Dan K."));

    await fireEvent.press(sendButton());

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(callBody(postCalls()[0]!)).toMatchObject({ job_id: JOB.id });
  });

  it("two taps in one frame send one message", async () => {
    const { result } = await renderHook(() => useContactForm([]), { wrapper });
    await act(async () => {
      updateDraft({ topic: "payment", message: MESSAGE });
    });

    await act(async () => {
      result.current.submit();
      result.current.submit();
      await settle();
    });

    expect(postCalls()).toHaveLength(1);
  });

  it("opened again while its message is on its way, the form still waits and sends nothing more", async () => {
    const first = await renderHook(() => useContactForm([]), { wrapper });
    await act(async () => {
      updateDraft({ topic: "payment", message: MESSAGE });
    });
    await act(async () => {
      first.result.current.submit();
      await settle();
    });
    await first.unmount();

    // The draft outlives the screen, and so does the wait for its answer.
    const again = await renderHook(() => useContactForm([]), { wrapper });
    expect(again.result.current.busy).toBe(true);
    await act(async () => {
      again.result.current.submit();
      await settle();
    });
    expect(postCalls()).toHaveLength(1);
    await again.unmount();

    // On the screen: the same draft, Send busy; the answer is then confirmed there.
    await renderForm();
    expect(field().props.value).toBe(MESSAGE);
    expect(sendButton()).toBeBusy();
    mine = [ticket()];
    await answer(0, (post) => post.resolve(created()));
    await waitFor(() => expect(screen.getByTestId("contact-sent")).toBeOnTheScreen());
    expect(postCalls()).toHaveLength(1);
  });

  it("a message that goes after the form was left is no longer a draft; the next visit says so, once", async () => {
    const view = await renderForm();
    await write();
    await fireEvent.press(sendButton());
    await waitFor(() => expect(posts).toHaveLength(1));
    await view.unmount();

    mine = [ticket()];
    await answer(0, (post) => post.resolve(created()));

    const next = await renderForm();
    expect(screen.getByTestId("contact-sent")).toBeOnTheScreen();
    await next.unmount();

    // Seen once: a later visit opens on an empty form.
    await renderForm();
    expect(screen.queryByTestId("contact-sent")).toBeNull();
    expect(field().props.value).toBe("");
    expect(postCalls()).toHaveLength(1);
  });

  it("a message that fails after the form was left is still the draft; the next visit says why", async () => {
    const view = await renderForm();
    await write();
    await fireEvent.press(sendButton());
    await waitFor(() => expect(posts).toHaveLength(1));
    await view.unmount();

    await answer(0, offline);

    await renderForm();
    expect(failure()).toHaveTextContent(/^We couldn't send your message/);
    expect(field().props.value).toBe(MESSAGE);
    expect(sendButton()).toBeEnabled();
  });

  it("a send that got no answer reads the list again: a message that did arrive shows there", async () => {
    await renderForm();
    await write();
    await fireEvent.press(sendButton());
    await waitFor(() => expect(posts).toHaveLength(1));

    mine = [ticket()]; // it reached the server; only the answer was lost
    await answer(0, offline);

    await waitFor(() =>
      expect(screen.getByTestId(`contact-ticket-${ticket().id}`)).toBeOnTheScreen(),
    );
    expect(failure()).toBeOnTheScreen();
    expect(field().props.value).toBe(MESSAGE);
  });

  it("offline, keeps the draft, says so calmly and sends again on Try again", async () => {
    await renderForm();
    await write();
    await fireEvent.press(sendButton());

    await answer(0, offline);

    await waitFor(() => expect(failure()).toBeOnTheScreen());
    expect(failure()).toHaveTextContent(
      "We couldn't send your messageIt's still here. Check your connection, then try again.",
    );
    expect(field().props.value).toBe(MESSAGE);
    expect(topic("A payment")).toBeChecked();
    expect(postCalls()).toHaveLength(1); // nothing retried by itself

    await fireEvent.press(screen.getByRole("button", { name: "Try again" }));
    await answer(1, (post) => post.resolve(created()));

    await waitFor(() => expect(screen.getByTestId("contact-sent")).toBeOnTheScreen());
    expect(callBody(postCalls()[1]!)).toMatchObject({ message: MESSAGE });
  });

  it("refused for sending too many, asks to try later and does not try again by itself", async () => {
    await renderForm();
    await write();
    await fireEvent.press(sendButton());

    await answer(0, (post) => post.resolve(errorResponse(429, "rate_limited")));

    await waitFor(() => expect(failure()).toBeOnTheScreen());
    expect(failure()).toHaveTextContent(
      "You've sent several messages recentlyYour message is still here. Please try again later.",
    );
    expect(field().props.value).toBe(MESSAGE);
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
    await act(settle);
    expect(postCalls()).toHaveLength(1);
  });

  it("drops a job the server refuses and says so; the message goes without it", async () => {
    hasJob = true;
    await renderForm();
    await write();
    await fireEvent.press(topic("My job with Dan K."));
    await fireEvent.press(sendButton());

    await answer(0, (post) => post.resolve(errorResponse(422, "invalid_job")));

    await waitFor(() => expect(failure()).toBeOnTheScreen());
    expect(failure()).toHaveTextContent(
      "We removed the job from your messageThat job can't be attached anymore. You can send your message without it.",
    );
    expect(topic("Not about a job")).toBeChecked();
    expect(field().props.value).toBe(MESSAGE);

    await fireEvent.press(sendButton());
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(callBody(postCalls()[1]!)).toMatchObject({ job_id: null, message: MESSAGE });
  });

  it("any other refusal keeps the draft too", async () => {
    await renderForm();
    await write();
    await fireEvent.press(sendButton());

    await answer(0, (post) => post.resolve(errorResponse(500, "internal_error")));

    await waitFor(() => expect(failure()).toBeOnTheScreen());
    expect(failure()).toHaveTextContent(
      "We couldn't send your messageIt's still here. Try again in a moment.",
    );
    expect(field().props.value).toBe(MESSAGE);
  });
});

describe("Talk to Jack: the person's messages", () => {
  it("lists them with their status", async () => {
    mine = [
      ticket({ id: "a", topic: "job", status: "open" }),
      ticket({ id: "b", topic: "account", status: "in_progress" }),
      ticket({ id: "c", topic: "other", status: "closed" }),
    ];
    await renderForm();

    expect(screen.getByTestId("contact-ticket-a")).toHaveTextContent("A jobTodayOpen");
    expect(screen.getByTestId("contact-ticket-b")).toHaveTextContent("My accountTodayIn progress");
    expect(screen.getByTestId("contact-ticket-c")).toHaveTextContent("Something elseTodayClosed");
  });

  it("shows nothing while there are none", async () => {
    await renderForm();
    expect(screen.queryByText("Your messages")).toBeNull();
  });

  it("offers to load them again when the list failed", async () => {
    mine = "down";
    await renderForm();

    expect(screen.getByTestId("contact-mine-error")).toHaveTextContent(
      /^We couldn't load your messages/,
    );
    mine = [ticket()];
    await fireEvent.press(screen.getByTestId("contact-mine-retry"));

    await waitFor(() =>
      expect(screen.getByTestId(`contact-ticket-${ticket().id}`)).toBeOnTheScreen(),
    );
  });
});

describe("Talk to Jack: privacy", () => {
  it("keeps the message out of every log, on success and on failure", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
      jest.spyOn(console, method).mockImplementation(),
    );
    try {
      await renderForm();
      await write();
      await fireEvent.press(sendButton());
      await answer(0, offline);
      await waitFor(() => expect(failure()).toBeOnTheScreen());
      await fireEvent.press(screen.getByRole("button", { name: "Try again" }));
      await answer(1, (post) => post.resolve(errorResponse(500, "internal_error")));
      await waitFor(() => expect(failure()).toBeOnTheScreen());
      await fireEvent.press(screen.getByRole("button", { name: "Try again" }));
      mine = [ticket()];
      await answer(2, (post) => post.resolve(created()));
      await waitFor(() => expect(screen.getByTestId("contact-sent")).toBeOnTheScreen());

      const logged = spies.flatMap((spy) => spy.mock.calls.map((args) => JSON.stringify(args)));
      expect(logged.filter((line) => line.includes("zanahoria"))).toEqual([]);
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
  });

  it("keeps no text of a sent message: not from the list's answer, not from the one just sent", async () => {
    mine = [ticket({ id: "a", message: "an older zanahoria message" })];
    await renderForm();
    await write();
    await fireEvent.press(sendButton());
    mine = [ticket(), ...mine];
    await answer(0, (post) => post.resolve(created()));
    await waitFor(() => expect(screen.getByTestId("contact-sent")).toBeOnTheScreen());
    await act(settle);

    // On screen: what each is about, its day and its status, and no text.
    expect(screen.getByTestId("contact-ticket-a")).toHaveTextContent("A paymentTodayOpen");
    expect(screen.queryByText(/zanahoria/)).toBeNull();
    // In the cache: the same.
    const cached = client
      .getQueryCache()
      .getAll()
      .map((query) => query.state.data);
    expect(JSON.stringify(cached)).toContain(ticket().id);
    expect(JSON.stringify(cached)).not.toContain("zanahoria");
  });

  it("keeps the message out of every query and mutation key", async () => {
    mine = [ticket()];
    await renderForm();
    await write();
    await fireEvent.press(sendButton());
    await answer(0, (post) => post.resolve(created()));
    await waitFor(() => expect(screen.getByTestId("contact-sent")).toBeOnTheScreen());

    const keys = [
      ...client
        .getQueryCache()
        .getAll()
        .map((query) => query.queryKey),
      ...client
        .getMutationCache()
        .getAll()
        .map((mutation) => mutation.options.mutationKey),
    ];
    expect(keys.length).toBeGreaterThan(0);
    expect(JSON.stringify(keys)).not.toContain("zanahoria");
    // And no mutation carries it: the send is a plain call.
    await act(settle);
    const carried = client
      .getMutationCache()
      .getAll()
      .map((mutation) => mutation.state.variables);
    expect(JSON.stringify(carried)).not.toContain("zanahoria");
  });

  it("keeps the draft while the form is left and comes back, in memory", async () => {
    const view = await renderForm();
    await write();

    await view.unmount();
    await renderForm();

    expect(field().props.value).toBe(MESSAGE);
    expect(topic("A payment")).toBeChecked();
  });

  it("forgets the draft at sign-out", async () => {
    await renderForm();
    await write();

    await act(async () => {
      await logout();
    });

    expect(field().props.value).toBe("");
    expect(topic("A payment")).not.toBeChecked();
  });

  it("an answer that lands after a sign-out leaves the next person's draft alone", async () => {
    await renderForm();
    await write();
    await fireEvent.press(sendButton());
    await waitFor(() => expect(posts).toHaveLength(1));

    await act(async () => {
      await logout();
    });
    signIn();
    await act(async () => {
      updateDraft({ topic: "other", message: "the next person's words" });
    });
    await answer(0, (post) => post.resolve(created()));

    expect(field().props.value).toBe("the next person's words");
    expect(screen.queryByTestId("contact-sent")).toBeNull();
  });
});

describe("sendFailureOf", () => {
  it.each([
    [new NetworkError(false), "offline"],
    [new NetworkError(true), "offline"],
    [new ApiError(429, "rate_limited"), "rateLimited"],
    [new ApiError(422, "invalid_job"), "invalidJob"],
    [new ApiError(422, "validation_error"), "failed"],
    [new ApiError(500, "internal_error"), "failed"],
    [new Error("anything else"), "failed"],
    // A 401 that did not end the session is a refusal like any other, never a dead tap.
    [new ApiError(401, "invalid_token"), "failed"],
    // The session ended: the signed-out handling takes over, the form says nothing.
    [new SessionExpiredError(), null],
  ])("%p reads as %p", (error, reason) => {
    expect(sendFailureOf(error)).toBe(reason);
  });
});
