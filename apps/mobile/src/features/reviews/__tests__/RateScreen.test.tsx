import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react-native";
import type { ApiSchema } from "@jack/shared";
import { router } from "expo-router";
import type { ReactNode } from "react";
import { AccessibilityInfo } from "react-native";
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
import { rateHref, reviewBodyOf, reviewFailureOf } from "../api";
import { forgetReviews, rate, writeComment } from "../draft";
import { RateEntry } from "../RateEntry";
import { RateScreen } from "../RateScreen";
import { useRateForm } from "../useRateForm";

jest.mock(
  "../../../api/config",
  () => jest.requireActual("../../../api/__tests__/helpers").configMock,
);
jest.mock(
  "expo-secure-store",
  () => jest.requireActual("../../../api/__tests__/helpers").secureStoreMock,
);
const mockParams: { current: { id: string; request?: string } } = { current: { id: "" } };
// A screen rendered on its own: focused, nothing navigating, the route's params set per test.
jest.mock("expo-router", () => {
  const router = {
    push: jest.fn(),
    back: jest.fn(),
    canGoBack: jest.fn(() => true),
    replace: jest.fn(),
    dismissTo: jest.fn(),
  };
  return {
    ...jest.requireActual("../../home/__tests__/helpers").homeRouterMock(),
    router,
    useRouter: () => router,
    useLocalSearchParams: () => mockParams.current,
  };
});
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);

type Answer = ReturnType<typeof deferred<Response>>;
type Mine = ApiSchema<"MyReviewOut">;

const JOB_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const REQUEST_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const REVIEWS = `/v1/jobs/${JOB_ID}/reviews`;
const MINE = `${REVIEWS}/mine`;
const HIDDEN = { includeHiddenElements: true };
// A word no string of the app holds, so a leak of a comment is easy to spot.
const COMMENT = "  The leak under the zanahoria sink is gone.  ";

const CAN_RATE: Mine = { review: null, can_review: true };
const NOT_YET: Mine = { review: null, can_review: false };
const rated = (overall: number): Mine => ({
  review: {
    id: "5d1b5a2e-2a8c-4b4e-9a53-7d1b5a2e2a8c",
    overall,
    communication: null,
    quality: null,
    punctuality: null,
    value: null,
    comment: "zanahoria, from the server",
    created_at: new Date().toISOString(),
  },
  can_review: false,
});

let fetchMock: FetchMock;
let client: QueryClient;
/** One entry per `POST .../reviews` the app sent, in order; the test answers each. */
let posts: Answer[];
/** What `GET .../reviews/mine` answers: a body, or an error status. */
let mine: Mine | 404 | 500;

const postCalls = () =>
  fetchMock.mock.calls.filter((call) => callPath(call) === REVIEWS && call[1]?.method === "POST");
const readsOfMine = () => fetchMock.mock.calls.filter((call) => callPath(call) === MINE).length;
const created = (redacted = false) =>
  jsonResponse(201, {
    id: "5d1b5a2e-2a8c-4b4e-9a53-7d1b5a2e2a8c",
    created_at: new Date().toISOString(),
    comment_redacted: redacted,
  });
const offline = (post: Answer) => post.reject(new TypeError("Network request failed"));

const stars = (name: string) => screen.queryByRole("adjustable", { name });
const overall = () => screen.getByRole("adjustable", { name: "Overall rating" });
const tap = (aspect: string, score: number) =>
  fireEvent.press(screen.getByTestId(`rate-${aspect}-${score}`, HIDDEN));
const sendButton = () => screen.getByTestId("rate-send");
const field = () => screen.getByTestId("rate-comment");
const failure = () => screen.queryByTestId("rate-failure");

function signIn(role: "customer" | "pro" = "customer"): void {
  sessionStore.setState({
    ...SIGNED_OUT,
    status: "signedIn",
    user: { ...user, role },
    accessToken: "access-1",
    accessTokenExpiresAt: Date.now() + 900_000,
  });
}

const wrapper = ({ children }: { children: ReactNode }) => (
  <SafeAreaProvider initialMetrics={METRICS}>
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  </SafeAreaProvider>
);

/** The rating screen, once its "mine" has answered and `state` shows. */
async function renderScreen(state = "rate-form") {
  const view = await render(<RateScreen />, { wrapper });
  await screen.findByTestId(state);
  return view;
}

/** A filled-in draft: four stars overall, a comment. */
async function fillIn(text = COMMENT): Promise<void> {
  await tap("overall", 4);
  await fireEvent.changeText(field(), text);
}

/** Settles the review the app sent `index`-th, and lets what follows from it happen. */
async function answer(index: number, settleWith: (post: Answer) => void): Promise<void> {
  await waitFor(() => expect(posts.length).toBeGreaterThan(index));
  await act(async () => {
    settleWith(posts[index]!);
    await settle();
  });
}

beforeEach(async () => {
  posts = [];
  mine = CAN_RATE;
  mockParams.current = { id: JOB_ID, request: REQUEST_ID };
  fetchMock = installFetchMock();
  fetchMock.mockImplementation(async (...call) => {
    const path = callPath(call);
    if (path === REVIEWS && call[1]?.method === "POST") {
      const post = deferred<Response>();
      posts.push(post);
      return post.promise;
    }
    if (path === MINE) {
      if (mine === 404) return errorResponse(404, "not_found");
      if (mine === 500) return errorResponse(500, "internal_error");
      return jsonResponse(200, mine);
    }
    if (path === "/v1/auth/logout") return jsonResponse(204);
    return errorResponse(404, "not_found");
  });
  resetSecureStore();
  forgetReviews();
  // Nothing in the cache expires: a garbage-collection timer would outlive the test.
  client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } });
  attachQueryClient(client);
  jest.mocked(router.dismissTo).mockClear();
  jest.mocked(router.back).mockClear();
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

describe("RateScreen: the form", () => {
  it("asks the customer for overall stars, four optional dimensions and a comment", async () => {
    await renderScreen();

    expect(screen.getByRole("header", { name: "Rate your pro" })).toBeOnTheScreen();
    expect(overall()).toHaveAccessibilityValue({ now: 0, text: "Not rated" });
    expect(screen.getByText("Tap a star to rate")).toBeOnTheScreen();
    for (const name of ["Communication", "Quality of the work", "Punctuality", "Value for money"]) {
      expect(stars(name)).toBeOnTheScreen();
    }
    expect(screen.getByText("Don't share phone numbers or emails: they are removed.")).toBeTruthy();
    expect(screen.getByText("Comment (optional)")).toBeOnTheScreen();
  });

  it("asks the pro only for overall, communication and punctuality", async () => {
    signIn("pro");
    await renderScreen();

    expect(screen.getByRole("header", { name: "Rate your customer" })).toBeOnTheScreen();
    expect(screen.getAllByRole("adjustable")).toHaveLength(3);
    expect(stars("Communication")).toBeOnTheScreen();
    expect(stars("Punctuality")).toBeOnTheScreen();
    expect(stars("Quality of the work")).toBeNull();
    expect(stars("Value for money")).toBeNull();
  });

  it("keeps Send disabled until the overall stars are given; the dimensions are optional", async () => {
    await renderScreen();
    expect(sendButton()).toBeDisabled();

    await tap("communication", 5);
    await fireEvent.changeText(field(), "Great");
    expect(sendButton()).toBeDisabled();

    await tap("overall", 3);
    expect(overall()).toHaveAccessibilityValue({ now: 3, text: "3 of 5 stars" });
    expect(screen.getByTestId("rate-overall-word")).toHaveTextContent("Good");
    expect(sendButton()).toBeEnabled();
  });

  it("counts toward 1000 characters, and past them says by how much and waits", async () => {
    await renderScreen();
    await tap("overall", 5);

    await fireEvent.changeText(field(), "a".repeat(1003));

    expect(screen.getByText("Your comment is 3 characters too long.")).toBeOnTheScreen();
    expect(field().props.value).toHaveLength(1003); // never cut behind the person's back
    expect(sendButton()).toBeDisabled();
  });

  it("reads in Spanish", async () => {
    await i18n.changeLanguage("es");
    await renderScreen();

    expect(screen.getByRole("header", { name: "Califica a tu profesional" })).toBeOnTheScreen();
    expect(stars("Calificación general")).toBeOnTheScreen();
    expect(screen.getByText("No compartas teléfonos ni correos: se eliminan.")).toBeTruthy();
  });
});

describe("RateScreen: what the job's 'mine' shows", () => {
  it("before the job is confirmed: a calm 'not yet' and the way back", async () => {
    mine = NOT_YET;
    await renderScreen("rate-not-yet");

    expect(screen.getByText("You can rate after the job is confirmed.")).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole("button", { name: "Back to the job" }));
    expect(router.back).toHaveBeenCalled();
  });

  it("a job already rated: its stars and the thanks, no form, nothing announced", async () => {
    const say = jest.spyOn(AccessibilityInfo, "announceForAccessibilityWithOptions");
    mine = rated(3);
    await renderScreen("rate-thanks");

    expect(screen.getByTestId("rate-thanks-body")).toHaveTextContent("You gave this job 3 stars.");
    expect(screen.queryByTestId("rate-send")).toBeNull();
    expect(screen.queryByTestId("rate-redacted")).toBeNull();
    expect(say).not.toHaveBeenCalled();
  });

  it("not this person's job: the gone state, home from there", async () => {
    mine = 404;
    await renderScreen("rate-gone");

    await fireEvent.press(screen.getByRole("button", { name: "Go to Home" }));
    expect(router.dismissTo).toHaveBeenCalledWith("/");
  });

  it("a read that failed: try again, and the form once it answers", async () => {
    mine = 500;
    await renderScreen("rate-load-failed");

    mine = CAN_RATE;
    await fireEvent.press(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByTestId("rate-form")).toBeOnTheScreen();
  });

  it("a link with no valid job asks nothing", async () => {
    mockParams.current = { id: "not-a-job" };
    await renderScreen("rate-gone");

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("RateScreen: sending", () => {
  it("sends what the customer gave, once, then thanks them with the stars", async () => {
    const say = jest.spyOn(AccessibilityInfo, "announceForAccessibilityWithOptions");
    await renderScreen();
    await tap("overall", 4);
    await tap("communication", 5);
    await tap("quality", 3);
    await tap("punctuality", 4);
    await tap("value", 2);
    await fireEvent.changeText(field(), COMMENT);

    await fireEvent.press(sendButton());

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(sendButton()).toBeBusy();
    expect(overall()).toBeDisabled();
    expect(callBody(postCalls()[0]!)).toEqual({
      overall: 4,
      communication: 5,
      quality: 3,
      punctuality: 4,
      value: 2,
      comment: COMMENT.trim(),
    });

    await answer(0, (post) => post.resolve(created()));

    expect(await screen.findByTestId("rate-thanks")).toBeOnTheScreen();
    expect(screen.getByTestId("rate-thanks-body")).toHaveTextContent("You gave this job 4 stars.");
    expect(screen.queryByTestId("rate-redacted")).toBeNull();
    expect(say).toHaveBeenCalledWith("Thanks for rating. You gave this job 4 stars.", {
      queue: true,
    });
    expect(postCalls()).toHaveLength(1);
  });

  it("sends only what a pro may rate: never quality or value, whatever the draft holds", async () => {
    signIn("pro");
    // A draft started as the customer on this phone, say: the pro's screen has no such rows.
    await act(async () => {
      rate(JOB_ID, "quality", 5);
      rate(JOB_ID, "value", 1);
    });
    await renderScreen();
    await tap("overall", 2);
    await tap("punctuality", 1);

    await fireEvent.press(sendButton());

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(callBody(postCalls()[0]!)).toEqual({ overall: 2, punctuality: 1 });
  });

  it("says calmly that contact details were taken out of the comment", async () => {
    await renderScreen();
    await fillIn("Call me at 954 555 0142");

    await fireEvent.press(sendButton());
    await answer(0, (post) => post.resolve(created(true)));

    const note = await screen.findByTestId("rate-redacted");
    expect(note).toHaveTextContent(/Contact details aren't shared in reviews/);
  });

  it("two taps in one frame send one review", async () => {
    const { result } = await renderHook(() => useRateForm(JOB_ID, "customer"), { wrapper });
    await act(async () => {
      rate(JOB_ID, "overall", 5);
    });

    await act(async () => {
      result.current.submit();
      result.current.submit();
      await settle();
    });

    expect(postCalls()).toHaveLength(1);
  });

  it("opened again while its review is on its way, the screen waits and sends nothing more", async () => {
    const first = await renderHook(() => useRateForm(JOB_ID, "customer"), { wrapper });
    await act(async () => {
      rate(JOB_ID, "overall", 5);
    });
    await act(async () => {
      first.result.current.submit();
      await settle();
    });
    await first.unmount();

    const again = await renderHook(() => useRateForm(JOB_ID, "customer"), { wrapper });
    expect(again.result.current.busy).toBe(true);
    await act(async () => {
      again.result.current.submit();
      await settle();
    });

    expect(postCalls()).toHaveLength(1);
  });

  it("offline, keeps the draft, says so calmly and sends again on Try again", async () => {
    await renderScreen();
    await fillIn();
    await fireEvent.press(sendButton());

    await answer(0, offline);

    await waitFor(() => expect(failure()).toBeOnTheScreen());
    expect(failure()).toHaveTextContent(/We couldn't send your rating/);
    expect(overall()).toHaveAccessibilityValue({ now: 4 });
    expect(field().props.value).toBe(COMMENT);

    await fireEvent.press(screen.getByRole("button", { name: "Try again" }));
    await answer(1, (post) => post.resolve(created()));
    expect(await screen.findByTestId("rate-thanks")).toBeOnTheScreen();
  });

  it("refused for too many ratings, asks to send later and does not try again by itself", async () => {
    await renderScreen();
    await fillIn();
    await fireEvent.press(sendButton());

    await answer(0, (post) => post.resolve(errorResponse(429, "rate_limited")));

    await waitFor(() => expect(failure()).toBeOnTheScreen());
    expect(failure()).toHaveTextContent(/That's a lot of ratings for now/);
    expect(screen.getByRole("button", { name: "Send rating" })).toBeEnabled();
    expect(field().props.value).toBe(COMMENT);
    await act(settle);
    expect(postCalls()).toHaveLength(1);
  });

  it("already rated (another phone, say): reads 'mine' again and shows its thanks", async () => {
    await renderScreen();
    await fillIn();
    await fireEvent.press(sendButton());

    mine = rated(5);
    await answer(0, (post) => post.resolve(errorResponse(409, "already_reviewed")));

    expect(await screen.findByTestId("rate-thanks")).toBeOnTheScreen();
    expect(screen.getByTestId("rate-thanks-body")).toHaveTextContent("You gave this job 5 stars.");
  });

  it("already rated and 'mine' unreadable: nothing to edit or send; Try again only reads, then thanks with the saved stars", async () => {
    const say = jest.spyOn(AccessibilityInfo, "announceForAccessibilityWithOptions");
    await renderScreen();
    await fillIn();
    await fireEvent.press(sendButton());

    mine = 500;
    await answer(0, (post) => post.resolve(errorResponse(409, "already_reviewed")));

    expect(await screen.findByTestId("rate-rated-unavailable")).toBeOnTheScreen();
    expect(screen.getByText("You already rated this job")).toBeOnTheScreen();
    expect(screen.getByText("We can't load your rating right now.")).toBeOnTheScreen();
    expect(screen.queryByTestId("rate-form")).toBeNull();
    expect(screen.queryByTestId("rate-send")).toBeNull();
    expect(screen.queryByTestId("rate-comment")).toBeNull();
    expect(stars("Overall rating")).toBeNull();
    expect(say.mock.calls.filter(([message]) => message.startsWith("You already rated"))).toEqual([
      ["You already rated this job. We can't load your rating right now.", expect.anything()],
    ]);

    const before = readsOfMine();
    mine = rated(3);
    await fireEvent.press(screen.getByRole("button", { name: "Try again" }));

    // The server's stars, not the refused draft's four.
    expect(await screen.findByTestId("rate-thanks")).toBeOnTheScreen();
    expect(screen.getByTestId("rate-thanks-body")).toHaveTextContent("You gave this job 3 stars.");
    expect(readsOfMine()).toBe(before + 1);
    expect(postCalls()).toHaveLength(1);
    // The refused draft is gone from memory.
    const { result } = await renderHook(() => useRateForm(JOB_ID, "customer"), { wrapper });
    expect(result.current.ratings).toStrictEqual({});
    expect(result.current.comment).toBe("");
  });

  it("already rated and 'mine' still unreadable: Try again reads once and stays calm, also on the next visit", async () => {
    const view = await renderScreen();
    await fillIn();
    await fireEvent.press(sendButton());
    mine = 500;
    await answer(0, (post) => post.resolve(errorResponse(409, "already_reviewed")));
    await screen.findByTestId("rate-rated-unavailable");

    const before = readsOfMine();
    await fireEvent.press(screen.getByRole("button", { name: "Try again" }));
    await act(settle);

    expect(readsOfMine()).toBe(before + 1);
    expect(screen.getByTestId("rate-rated-unavailable")).toBeOnTheScreen();
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();

    // Final for the session: opened again while "mine" still fails, the form does not come back.
    await view.unmount();
    await renderScreen("rate-rated-unavailable");
    await act(settle);
    expect(screen.queryByTestId("rate-send")).toBeNull();
    expect(postCalls()).toHaveLength(1);
  });

  it("a job that cannot be rated: 'You can rate after the job is confirmed'", async () => {
    await renderScreen();
    await fillIn();
    await fireEvent.press(sendButton());

    mine = NOT_YET;
    await answer(0, (post) => post.resolve(errorResponse(409, "job_not_reviewable")));

    expect(await screen.findByTestId("rate-not-yet")).toBeOnTheScreen();
    expect(screen.getByText("You can rate after the job is confirmed.")).toBeOnTheScreen();
  });

  it("a job that cannot be rated and 'mine' unreadable: still 'not yet', nothing to send", async () => {
    await renderScreen();
    await fillIn();
    await fireEvent.press(sendButton());

    mine = 500;
    await answer(0, (post) => post.resolve(errorResponse(409, "job_not_reviewable")));

    expect(await screen.findByTestId("rate-not-yet")).toBeOnTheScreen();
    expect(screen.queryByTestId("rate-send")).toBeNull();
    expect(postCalls()).toHaveLength(1);
  });

  it("a job that is not this person's: the gone state", async () => {
    await renderScreen();
    await fillIn();
    await fireEvent.press(sendButton());

    await answer(0, (post) => post.resolve(errorResponse(404, "not_found")));

    expect(await screen.findByTestId("rate-gone")).toBeOnTheScreen();
  });

  it("any other refusal keeps the draft too, with Try again", async () => {
    await renderScreen();
    await fillIn();
    await fireEvent.press(sendButton());

    await answer(0, (post) => post.resolve(errorResponse(500, "internal_error")));

    await waitFor(() => expect(failure()).toBeOnTheScreen());
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
    expect(field().props.value).toBe(COMMENT);
  });
});

describe("RateScreen: privacy", () => {
  it("keeps the comment out of every log, on failure and on success", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
      jest.spyOn(console, method).mockImplementation(),
    );
    try {
      await renderScreen();
      await fillIn();
      await fireEvent.press(sendButton());
      await answer(0, offline);
      await waitFor(() => expect(failure()).toBeOnTheScreen());
      await fireEvent.press(screen.getByRole("button", { name: "Try again" }));
      await answer(1, (post) => post.resolve(created()));
      await screen.findByTestId("rate-thanks");

      const logged = spies.flatMap((spy) => spy.mock.calls.map((args) => JSON.stringify(args)));
      expect(logged.filter((line) => line.includes("zanahoria"))).toEqual([]);
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
  });

  it("keeps no comment in a query or mutation key, nor in the cache (its own or the server's)", async () => {
    await renderScreen();
    await fillIn();
    await fireEvent.press(sendButton());
    mine = rated(4);
    await answer(0, (post) => post.resolve(created()));
    await screen.findByTestId("rate-thanks");
    // "Mine" is read again too: the server's copy of the comment stays out of the cache.
    await act(async () => client.refetchQueries());

    const queries = client.getQueryCache().getAll();
    const mutations = client.getMutationCache().getAll();
    const kept = JSON.stringify([
      queries.map((query) => [query.queryKey, query.state.data]),
      mutations.map((mutation) => [mutation.options.mutationKey, mutation.state.variables]),
    ]);
    expect(queries.length).toBeGreaterThan(0);
    expect(kept).not.toContain("zanahoria");
  });

  it("asks only for the person's own review: never the other side's", async () => {
    await renderScreen();
    await fillIn();
    await fireEvent.press(sendButton());
    await answer(0, (post) => post.resolve(created()));
    await screen.findByTestId("rate-thanks");

    const paths = new Set(fetchMock.mock.calls.map(callPath));
    expect([...paths].sort()).toEqual([REVIEWS, MINE].sort());
  });

  it("keeps the draft while the screen is left and comes back, in memory", async () => {
    const view = await renderScreen();
    await fillIn();

    await view.unmount();
    await renderScreen();

    expect(overall()).toHaveAccessibilityValue({ now: 4 });
    expect(field().props.value).toBe(COMMENT);
  });

  it("forgets the draft at sign-out", async () => {
    const view = await renderScreen();
    await fillIn();

    await act(async () => {
      await logout();
    });
    await view.unmount();
    signIn();
    await renderScreen();

    expect(overall()).toHaveAccessibilityValue({ now: 0 });
    expect(field().props.value).toBe("");
  });

  it("an answer that lands after a sign-out leaves the next person's draft alone", async () => {
    const view = await renderScreen();
    await fillIn();
    await fireEvent.press(sendButton());
    await waitFor(() => expect(posts).toHaveLength(1));

    await act(async () => {
      await logout();
    });
    await view.unmount();
    signIn();
    await act(async () => {
      writeComment(JOB_ID, "the next person's words");
    });
    await answer(0, (post) => post.resolve(created()));
    await renderScreen();

    expect(field().props.value).toBe("the next person's words");
    expect(sendButton()).not.toBeBusy();
  });
});

describe("RateEntry", () => {
  const renderEntry = (side: "customer" | "pro" = "customer", enabled = true) =>
    render(
      <RateEntry
        jobId={JOB_ID}
        requestId={side === "customer" ? REQUEST_ID : undefined}
        side={side}
        enabled={enabled}
      />,
      { wrapper },
    );

  it("while a review can be written: 'Rate your pro', which opens the rating screen", async () => {
    await renderEntry();

    const entry = await screen.findByRole("button", { name: "Rate your pro" });
    await fireEvent.press(entry);

    expect(router.push).toHaveBeenCalledWith(rateHref(JOB_ID, REQUEST_ID));
  });

  it("for the pro: 'Rate your customer'", async () => {
    signIn("pro");
    await renderEntry("pro");

    expect(await screen.findByRole("button", { name: "Rate your customer" })).toBeOnTheScreen();
  });

  it("once rated: the thanks with the stars, for good, and no way to edit", async () => {
    mine = rated(4);
    await renderEntry();

    expect(await screen.findByLabelText("Thanks, you rated 4 stars")).toBeOnTheScreen();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("neither, or while 'mine' loads or failed: nothing", async () => {
    mine = NOT_YET;
    const view = await renderEntry();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await act(settle);
    expect(view.toJSON()).toBeNull();
    await view.unmount();

    mine = 500;
    client.clear();
    const failed = await renderEntry();
    await act(settle);
    expect(failed.toJSON()).toBeNull();
  });

  it("asks nothing for a job that cannot have been confirmed", async () => {
    await renderEntry("pro", false);
    await act(settle);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("reviewBodyOf", () => {
  it("drops what the side may not rate, and an empty comment", () => {
    expect(
      reviewBodyOf("pro", { overall: 3, communication: 2, quality: 5, value: 4 }, "   "),
    ).toEqual({ overall: 3, communication: 2 });
    expect(reviewBodyOf("customer", { overall: 3, value: 4 }, " Good ")).toEqual({
      overall: 3,
      value: 4,
      comment: "Good",
    });
  });

  it("is null without overall stars or with a comment over the limit", () => {
    expect(reviewBodyOf("customer", { communication: 5 }, "")).toBeNull();
    expect(reviewBodyOf("customer", { overall: 5 }, "a".repeat(1001))).toBeNull();
    expect(reviewBodyOf("customer", { overall: 5 }, "a".repeat(1000))).not.toBeNull();
  });
});

describe("reviewFailureOf", () => {
  it.each([
    [new NetworkError(false), "offline"],
    [new ApiError(429, "rate_limited"), "rateLimited"],
    [new ApiError(409, "already_reviewed"), "alreadyReviewed"],
    [new ApiError(409, "job_not_reviewable"), "notReviewable"],
    [new ApiError(404, "not_found"), "gone"],
    [new ApiError(422, "validation_error"), "failed"],
    [new ApiError(500, "internal_error"), "failed"],
    [new SessionExpiredError(), null],
  ])("%s -> %s", (error, expected) => {
    expect(reviewFailureOf(error)).toBe(expected);
  });
});
