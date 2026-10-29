import "@/i18n";

import type { QueryClient } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import { router } from "expo-router";
import { AccessibilityInfo, Alert, type AlertButton } from "react-native";

import { ApiError, apiGet, apiPost, NetworkError } from "@/api";

import { flattenOpportunities, OPPORTUNITIES_QUERY_KEY } from "../../pro-home/useOpportunities";
import { OpportunityDetailScreen } from "../OpportunityDetailScreen";
import { QuoteFormScreen } from "../QuoteFormScreen";
import {
  forgetOpportunity,
  opportunityQueryKey,
  opportunityQueryOptions,
  type OpportunityDetail,
} from "../useOpportunity";
import type { SentQuote } from "../useSendQuote";
import {
  detail,
  DISPATCH_ID,
  freezeClock,
  GO_BACK,
  hoursFromNow,
  navigation,
  newQueryClient,
  NOW,
  page,
  renderWithQuery,
  summary,
} from "./helpers";

jest.mock("@/api", () => ({
  ...jest.requireActual("../../../api/errors"),
  apiGet: jest.fn(),
  apiPost: jest.fn(),
}));
jest.mock("expo-router", () => jest.requireActual("./helpers").routerMock);
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);

const POST = "/v1/pros/me/opportunities/{dispatch_id}/quote";
const SCOPE = "Paint the hallway and two bedrooms, two coats.";
const CAP = "Above the most Jack allows for one quote.";
const HIDDEN = { includeHiddenElements: true };
const PART = { exact: false };
/** The customer's preferred day in the fixture (2026-10-30) at 9:00 AM, in the test's time zone. */
const PREFERRED_START = new Date(2026, 9, 30, 9).getTime();

/** The server's answer. Its payout differs from the form's preview on purpose: it is the truth. */
const sentQuote = (overrides: Partial<SentQuote> = {}): SentQuote => ({
  id: "00000000-0000-4000-8000-000000000249",
  amount_cents: 10_000,
  scope: SCOPE,
  approach: null,
  duration_minutes: 75,
  proposed_start_at: new Date(PREFERRED_START).toISOString(),
  expires_at: hoursFromNow(24),
  status: "pending",
  created_at: new Date(NOW).toISOString(),
  pro_payout_cents: 8400,
  platform_fee_cents: 1600,
  ...overrides,
});

/** The list behind the detail (this opportunity and another) and the detail the form reads. */
function seededClient(): QueryClient {
  const client = newQueryClient();
  client.setQueryData(OPPORTUNITIES_QUERY_KEY, {
    pages: [page([summary(1, { dispatch_id: DISPATCH_ID }), summary(2)])],
    pageParams: [undefined],
  });
  client.setQueryData(opportunityQueryKey(DISPATCH_ID), detail());
  return client;
}

const listedIds = (client: QueryClient) =>
  flattenOpportunities(client.getQueryData(OPPORTUNITIES_QUERY_KEY)).map(
    (item) => item.dispatch_id,
  );

async function renderForm(client: QueryClient = seededClient()) {
  await renderWithQuery(<QuoteFormScreen />, client);
  await screen.findByTestId("quote-form");
  return client;
}

const typeInto = (testID: string, text: string) =>
  fireEvent.changeText(screen.getByTestId(testID), text);
const press = (testID: string) => fireEvent.press(screen.getByTestId(testID));

/** $100, the scope, 1 h 15 min, the default start; then the review. */
async function fillAndReview({ approach = "" } = {}) {
  await typeInto("quote-price", "100");
  await typeInto("quote-scope", SCOPE);
  if (approach) await typeInto("quote-approach", approach);
  await press("quote-hours-increment");
  await press("quote-minutes-increment");
  await press("quote-review");
  await screen.findByTestId("quote-review-step");
}

/** A POST the test answers when it chooses. */
function deferredPost() {
  let answer: (quote: SentQuote) => void = () => undefined;
  let fail: (error: unknown) => void = () => undefined;
  jest.mocked(apiPost).mockImplementationOnce(
    () =>
      new Promise((resolve, reject) => {
        answer = resolve as (quote: SentQuote) => void;
        fail = reject;
      }),
  );
  return { answer: (quote: SentQuote) => answer(quote), fail: (error: unknown) => fail(error) };
}

/** The detail's next GET, answered once it is out and when the test chooses. */
function deferredGet() {
  let settle:
    { answer: (value: OpportunityDetail) => void; fail: (error: unknown) => void } | undefined;
  jest.mocked(apiGet).mockImplementationOnce(
    () =>
      new Promise((resolve, fail) => {
        settle = { answer: resolve as (value: OpportunityDetail) => void, fail };
      }),
  );
  const out = () => waitFor(() => expect(settle).toBeDefined());
  return {
    answer: async (value: OpportunityDetail) => {
      await out();
      await act(async () => settle?.answer(value));
    },
    fail: async (error: unknown) => {
      await out();
      await act(async () => settle?.fail(error));
    },
  };
}

const alertButtons = (): AlertButton[] => jest.mocked(Alert.alert).mock.calls[0]?.[2] ?? [];

beforeEach(() => {
  freezeClock();
  navigation.reset();
  navigation.repeated.mockClear();
  jest.mocked(apiGet).mockReset().mockResolvedValue(detail());
  jest.mocked(apiPost).mockReset().mockResolvedValue(sentQuote());
  jest.mocked(router.dismissTo).mockClear();
  jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
  jest.mocked(AccessibilityInfo.announceForAccessibility).mockClear();
});

afterEach(() => {
  jest.useRealTimers();
  jest.mocked(Alert.alert).mockRestore();
});

describe("QuoteFormScreen: the form", () => {
  it("shows what the pro will receive on every keystroke, and nothing for an invalid price", async () => {
    await renderForm();
    const receive = () => screen.queryByTestId("quote-payout-receive");
    const fee = () => screen.queryByTestId("quote-payout-fee");

    expect(receive()).toBeNull();
    await typeInto("quote-price", "1");
    expect(receive()).toHaveTextContent("You'll receive $0.85");
    await typeInto("quote-price", "10");
    expect(receive()).toHaveTextContent("You'll receive $8.50");
    await typeInto("quote-price", "100");
    expect(receive()).toHaveTextContent("You'll receive $85.00");
    expect(fee()).toHaveTextContent("Jack's fee 15%: $15.00");
    await typeInto("quote-price", "99.99");
    expect(receive()).toHaveTextContent("You'll receive $84.99");
    expect(fee()).toHaveTextContent("Jack's fee 15%: $15.00");

    for (const invalid of ["abc", "100.555", "0", "21474836.48", "99,999,999,999,999", ""]) {
      await typeInto("quote-price", invalid);
      expect(receive()).toBeNull();
      expect(fee()).toBeNull();
    }
    expect(screen.getByTestId("quote-payout").props.accessibilityLiveRegion).toBe("polite");
  });

  it("uses the opportunity's take rate, rounded as the server rounds", async () => {
    const client = seededClient();
    client.setQueryData(opportunityQueryKey(DISPATCH_ID), detail({ take_rate_bps: 1250 }));
    jest.mocked(apiGet).mockResolvedValue(detail({ take_rate_bps: 1250 }));
    await renderForm(client);

    await typeInto("quote-price", "0.10");
    // 10 cents at 12.5% is a 1.25-cent fee: 1 cent, payout 9.
    expect(screen.getByTestId("quote-payout-receive")).toHaveTextContent("You'll receive $0.09");
    expect(screen.getByTestId("quote-payout-fee")).toHaveTextContent("Jack's fee 12.5%: $0.01");
  });

  it("writes a valid price with two decimals when the field is left", async () => {
    await renderForm();
    await typeInto("quote-price", "1000.5");
    await fireEvent(screen.getByTestId("quote-price"), "blur");
    expect(screen.getByTestId("quote-price").props.value).toBe("1000.50");

    await typeInto("quote-price", "abc");
    await fireEvent(screen.getByTestId("quote-price"), "blur");
    expect(screen.getByTestId("quote-price").props.value).toBe("abc");
  });

  it("opens on the customer's preferred day at 9:00 AM and names that day", async () => {
    await renderForm();
    expect(screen.getByTestId("quote-day-value")).toHaveTextContent("Fri, Oct 30");
    expect(screen.getByTestId("quote-time-value")).toHaveTextContent("9:00 AM");
    expect(screen.getByTestId("quote-preferred")).toHaveTextContent(
      "The customer prefers Fri, Oct 30.",
    );
  });

  it("opens on the next whole hour when the preferred day is past, and never steps back past now", async () => {
    const client = seededClient();
    client.setQueryData(opportunityQueryKey(DISPATCH_ID), detail({ preferred_date: null }));
    jest.mocked(apiGet).mockResolvedValue(detail({ preferred_date: null }));
    await renderForm(client);

    const nextHour = new Date(NOW);
    nextHour.setMinutes(0, 0, 0);
    nextHour.setHours(nextHour.getHours() + 1);
    expect(screen.queryByTestId("quote-preferred")).toBeNull();
    expect(screen.getByTestId("quote-time-value")).toHaveTextContent(
      new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" }).format(nextHour),
    );
    expect(screen.getByTestId("quote-day-decrement")).toBeDisabled();
    expect(screen.getByTestId("quote-time-decrement")).toBeEnabled();
    await press("quote-time-decrement");
    expect(screen.getByTestId("quote-time-decrement")).toBeDisabled();
  });

  it("keeps the duration's minutes between 0 and 45 and the hours at 0 or more", async () => {
    await renderForm();
    expect(screen.getByTestId("quote-hours-decrement")).toBeDisabled();
    expect(screen.getByTestId("quote-minutes-decrement")).toBeDisabled();
    for (let step = 0; step < 3; step += 1) await press("quote-minutes-increment");
    expect(screen.getByTestId("quote-minutes-value")).toHaveTextContent("45 min");
    expect(screen.getByTestId("quote-minutes-increment")).toBeDisabled();
    await press("quote-hours-increment");
    expect(screen.getByTestId("quote-hours-value")).toHaveTextContent("1 h");
  });

  it("marks every missing field and stays on the form", async () => {
    await renderForm();
    await press("quote-review");

    expect(screen.getByText("Enter your price.")).toBeTruthy();
    expect(screen.getByText("Say what your price includes.")).toBeTruthy();
    expect(screen.getByText("Add how long the job takes.")).toBeTruthy();
    expect(screen.getByTestId("quote-form-problems")).toHaveTextContent(
      "Check the fields marked in red.",
    );
    expect(screen.queryByTestId("quote-review-step")).toBeNull();

    // The marks follow the edits from then on.
    await typeInto("quote-price", "abc");
    expect(screen.getByText("Enter a price like 120 or 120.50.")).toBeTruthy();
    await typeInto("quote-price", "100");
    expect(screen.queryByText("Enter a price like 120 or 120.50.")).toBeNull();
  });

  it("counts the notes against their 2000-character bounds", async () => {
    await renderForm();
    expect(screen.getByTestId("quote-scope").props.maxLength).toBe(2000);
    expect(screen.getByTestId("quote-approach").props.maxLength).toBe(2000);
    await typeInto("quote-approach", "Two coats.");
    // Shown, not read: the field's limit stops typing at the bound.
    expect(screen.getByTestId("quote-approach-counter", HIDDEN)).toHaveTextContent("10 / 2000");
    expect(screen.getByTestId("quote-scope-counter", HIDDEN)).toHaveTextContent("0 / 2000");
  });
});

describe("QuoteFormScreen: review and send", () => {
  it("sends the exact QuoteCreate once, then shows the server's payout and evicts the row", async () => {
    const client = await renderForm();
    await fillAndReview();
    expect(screen.getByTestId("quote-review-summary")).toHaveTextContent(
      "Send quote for $100.00 · you'll receive $85.00",
    );
    expect(screen.queryByTestId("quote-review-approach")).toBeNull();

    const post = deferredPost();
    await press("quote-send");
    await waitFor(() => expect(screen.getByTestId("quote-send")).toBeDisabled());
    await press("quote-send");
    expect(screen.getByTestId("quote-edit")).toBeDisabled();
    expect(apiPost).toHaveBeenCalledTimes(1);
    expect(apiPost).toHaveBeenCalledWith(
      POST,
      {
        amount_cents: 10_000,
        scope: SCOPE,
        duration_minutes: 75,
        proposed_start_at: new Date(PREFERRED_START).toISOString(),
      },
      { auth: true, params: { dispatch_id: DISPATCH_ID } },
    );
    expect(jest.mocked(apiPost).mock.calls[0]?.[1]).not.toHaveProperty("approach");

    post.answer(sentQuote());
    expect(await screen.findByTestId("quote-sent")).toBeTruthy();
    expect(screen.getByTestId("quote-sent-payout")).toHaveTextContent("You'll receive$84.00");
    expect(screen.queryByText("$85.00")).toBeNull();
    expect(screen.getByTestId("quote-sent-price")).toHaveTextContent("Your price$100.00");
    expect(screen.getByText("We'll let you know if the customer accepts.")).toBeTruthy();
    expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith("Quote sent");
    expect(listedIds(client)).not.toContain(DISPATCH_ID);
    expect(client.getQueryData(opportunityQueryKey(DISPATCH_ID))).toBeUndefined();

    await press("quote-sent-home");
    await waitFor(() => expect(router.dismissTo).toHaveBeenCalledWith("/"));
  });

  it("sends the approach when the pro wrote one, and shows it in the review", async () => {
    await renderForm();
    await fillAndReview({ approach: "  Low-VOC paint; furniture covered.  " });
    expect(screen.getByTestId("quote-review-approach")).toHaveTextContent(
      "How I'll do the job (optional)Low-VOC paint; furniture covered.",
    );
    await press("quote-send");
    await screen.findByTestId("quote-sent");
    expect(jest.mocked(apiPost).mock.calls[0]?.[1]).toMatchObject({
      approach: "Low-VOC paint; furniture covered.",
    });
  });

  it("goes back to the form with everything kept, by Edit or by back", async () => {
    await renderForm();
    await fillAndReview();
    await press("quote-edit");
    expect(screen.getByTestId("quote-price").props.value).toBe("100");
    expect(screen.getByTestId("quote-scope").props.value).toBe(SCOPE);
    expect(screen.getByTestId("quote-minutes-value")).toHaveTextContent("15 min");

    await press("quote-review");
    await screen.findByTestId("quote-review-step");
    expect(navigation.attemptLeave()).toBe(false);
    expect(await screen.findByTestId("quote-form")).toBeTruthy();
    expect(screen.getByTestId("quote-price").props.value).toBe("100");
    expect(Alert.alert).not.toHaveBeenCalled();
  });

  it.each<[string, ApiError, string, string]>([
    [
      "409 not_quotable",
      new ApiError(409, "not_quotable"),
      "quote-closed-gone",
      "This request is no longer available",
    ],
    ["404", new ApiError(404, "not_found"), "quote-closed-gone", "nothing was sent"],
    [
      "409 quote_exists",
      new ApiError(409, "quote_exists"),
      "quote-closed-alreadyQuoted",
      "You already quoted this request",
    ],
  ])("on %s explains it, evicts the row and goes back to the list", async (_, error, id, copy) => {
    jest.mocked(apiPost).mockRejectedValue(error);
    const client = await renderForm();
    await fillAndReview();
    await press("quote-send");

    expect(await screen.findByTestId(id)).toHaveTextContent(copy, PART);
    expect(listedIds(client)).toEqual([summary(2).dispatch_id]);
    expect(client.getQueryData(opportunityQueryKey(DISPATCH_ID))).toBeUndefined();
    await press(`${id}-action`);
    await waitFor(() => expect(router.dismissTo).toHaveBeenCalledWith("/"));
  });

  it("on a 422 marks the price and the duration with the platform's cap, data kept", async () => {
    jest.mocked(apiPost).mockRejectedValue(new ApiError(422, "validation_error"));
    const client = await renderForm();
    await fillAndReview();
    await press("quote-send");

    expect(await screen.findByTestId("quote-form")).toBeTruthy();
    expect(screen.getAllByText(CAP)).toHaveLength(2);
    expect(screen.getByTestId("quote-price").props.value).toBe("100");
    expect(screen.getByTestId("quote-scope").props.value).toBe(SCOPE);
    expect(listedIds(client)).toContain(DISPATCH_ID);

    // A mark stays until its own field changes.
    await typeInto("quote-scope", `${SCOPE} Trim too.`);
    expect(screen.getAllByText(CAP)).toHaveLength(2);
    await typeInto("quote-price", "90");
    expect(screen.getAllByText(CAP)).toHaveLength(1);
    await press("quote-hours-increment");
    expect(screen.queryByText(CAP)).toBeNull();
  });

  it("on a 422 after the start went by marks the start, not the caps", async () => {
    jest.mocked(apiPost).mockRejectedValue(new ApiError(422, "validation_error"));
    await renderForm();
    await fillAndReview();
    jest.setSystemTime(PREFERRED_START + 60_000);
    await press("quote-send");

    expect(await screen.findByText("Pick a start that is still ahead.")).toBeTruthy();
    expect(screen.queryByText(CAP)).toBeNull();
  });

  it.each([
    ["a network error", new NetworkError(false)],
    ["a timeout", new NetworkError(true)],
    ["a 503", new ApiError(503, "not_configured")],
  ])(
    "on %s keeps the review and the data, and Try again sends the same quote",
    async (_, error) => {
      jest.mocked(apiPost).mockRejectedValueOnce(error);
      await renderForm();
      await fillAndReview();
      await press("quote-send");

      expect(await screen.findByTestId("quote-send-failed")).toHaveTextContent(
        "We couldn't send your quote. Check your connection and try again.",
      );
      expect(screen.getByTestId("quote-send")).toHaveTextContent("Try again");
      expect(screen.getByTestId("quote-review-scope")).toHaveTextContent(SCOPE, PART);

      await press("quote-send");
      expect(await screen.findByTestId("quote-sent")).toBeTruthy();
      expect(apiPost).toHaveBeenCalledTimes(2);
      expect(jest.mocked(apiPost).mock.calls[1]).toEqual(jest.mocked(apiPost).mock.calls[0]);
    },
  );
});

describe("QuoteFormScreen: leaving", () => {
  it("leaves an untouched form freely", async () => {
    await renderForm();
    expect(navigation.attemptLeave()).toBe(true);
  });

  it("asks before discarding what was typed, and leaves only on Discard", async () => {
    await renderForm();
    await typeInto("quote-scope", "Paint");
    expect(navigation.attemptLeave()).toBe(false);

    expect(Alert.alert).toHaveBeenCalledWith(
      "Discard this quote?",
      "What you entered will be lost.",
      expect.any(Array),
    );
    const [keep, discard] = alertButtons();
    expect(keep?.text).toBe("Keep editing");
    keep?.onPress?.();
    expect(navigation.repeated).not.toHaveBeenCalled();
    expect(navigation.attemptLeave()).toBe(false);

    await act(async () => discard?.onPress?.());
    expect(navigation.repeated).toHaveBeenCalledWith(GO_BACK);
    // The guard stays off once rendered again: nothing asks a second time.
    expect(navigation.attemptLeave()).toBe(true);
    expect(Alert.alert).toHaveBeenCalledTimes(2);
  });

  it("goes home from the confirmation on back, not to the closed detail", async () => {
    await renderForm();
    await fillAndReview();
    await press("quote-send");
    await screen.findByTestId("quote-sent");

    expect(navigation.attemptLeave()).toBe(false);
    await waitFor(() => expect(router.dismissTo).toHaveBeenCalledWith("/"));
    expect(Alert.alert).not.toHaveBeenCalled();
  });
});

describe("QuoteFormScreen: opened from a link", () => {
  it("loads the opportunity, then shows the form", async () => {
    const get = deferredGet();
    await renderWithQuery(<QuoteFormScreen />, newQueryClient());
    expect(screen.getByTestId("quote-loading")).toBeTruthy();
    await get.answer(detail());
    expect(await screen.findByTestId("quote-form")).toBeTruthy();
  });

  it("says when the opportunity is no longer open", async () => {
    jest.mocked(apiGet).mockRejectedValue(new ApiError(404, "not_found"));
    await renderWithQuery(<QuoteFormScreen />, newQueryClient());
    expect(await screen.findByTestId("quote-closed-gone")).toBeTruthy();
    await press("quote-closed-gone-action");
    expect(router.dismissTo).toHaveBeenCalledWith("/");
  });

  it("offers a retry when the opportunity could not be loaded", async () => {
    jest.mocked(apiGet).mockRejectedValueOnce(new NetworkError(false));
    await renderWithQuery(<QuoteFormScreen />, newQueryClient());
    await press((await screen.findByTestId("quote-load-error-action")).props.testID);
    expect(await screen.findByTestId("quote-form")).toBeTruthy();
  });
});

describe("QuoteFormScreen: denied over a cached detail", () => {
  it("cached detail then GET 404 closes the form", async () => {
    const get = deferredGet();
    const client = await renderForm();
    await typeInto("quote-price", "100");
    await get.fail(new ApiError(404, "not_found"));

    const after404 = () => ({
      closedShown: screen.queryByTestId("quote-closed-gone") !== null,
      formShown: screen.queryByTestId("quote-form") !== null,
      detailCached: client.getQueryData(opportunityQueryKey(DISPATCH_ID)) !== undefined,
      rowListed: listedIds(client).includes(DISPATCH_ID),
    });
    await waitFor(() =>
      expect(after404()).toEqual({
        closedShown: true,
        formShown: false,
        detailCached: false,
        rowListed: false,
      }),
    );
    // Nothing asks for the denied id again, rendered again or refetched, and the typed draft went
    // with the form: leaving does not offer to keep it.
    await screen.rerender(<QuoteFormScreen />);
    await act(() => client.refetchQueries({ queryKey: opportunityQueryKey(DISPATCH_ID) }));
    expect(apiGet).toHaveBeenCalledTimes(1);
    expect(navigation.attemptLeave()).toBe(true);
    await press("quote-closed-gone-action");
    expect(router.dismissTo).toHaveBeenCalledWith("/");
    expect(Alert.alert).not.toHaveBeenCalled();
  });

  it.each<[string, unknown]>([
    ["a network error", new NetworkError(false)],
    ["a 503", new ApiError(503, "unavailable")],
  ])("after the denial, a later load ending in %s does not restore it", async (_, failure) => {
    const get = deferredGet();
    const client = await renderForm();
    await get.fail(new ApiError(404, "not_found"));
    await screen.findByTestId("quote-closed-gone");
    await waitFor(() => expect(listedIds(client)).toEqual([summary(2).dispatch_id]));

    // Another screen asks for it and fails: the stale detail stays gone, here and in the cache.
    jest.mocked(apiGet).mockRejectedValue(failure);
    await act(async () => {
      await client.fetchQuery(opportunityQueryOptions(DISPATCH_ID)).catch(() => undefined);
    });
    expect(screen.getByTestId("quote-closed-gone")).toBeTruthy();
    expect(screen.queryByTestId("quote-form")).toBeNull();
    expect(client.getQueryData(opportunityQueryKey(DISPATCH_ID))).toBeUndefined();
    expect(listedIds(client)).toEqual([summary(2).dispatch_id]);

    // Opened again, the failed load offers a retry, not the old form.
    await screen.rerender(<QuoteFormScreen key="opened-again" />);
    expect(await screen.findByTestId("quote-load-error")).toBeTruthy();
    expect(screen.queryByTestId("quote-form")).toBeNull();
  });

  it("a 404 while the quote is out closes the form once the send fails and may go again", async () => {
    const get = deferredGet();
    const post = deferredPost();
    const client = await renderForm();
    await fillAndReview();
    await press("quote-send");
    await get.fail(new ApiError(404, "not_found"));
    expect(screen.getByTestId("quote-review-step")).toBeTruthy();

    await act(async () => post.fail(new NetworkError(false)));
    expect(await screen.findByTestId("quote-closed-gone")).toBeTruthy();
    expect(screen.queryByTestId("quote-review-step")).toBeNull();
    expect(screen.queryByTestId("quote-form")).toBeNull();
    await waitFor(() => expect(listedIds(client)).toEqual([summary(2).dispatch_id]));
    expect(client.getQueryData(opportunityQueryKey(DISPATCH_ID))).toBeUndefined();
  });

  it("a 201 then the post-send 404 keeps the confirmation", async () => {
    const get = deferredGet();
    const post = deferredPost();
    const client = await renderForm();
    await fillAndReview();
    await press("quote-send");

    // The detail answers 404 while the quote is out (it is being quoted), then the quote lands.
    await get.fail(new ApiError(404, "not_found"));
    expect(screen.getByTestId("quote-review-step")).toBeTruthy();
    await act(async () => post.answer(sentQuote()));
    expect(await screen.findByTestId("quote-sent")).toBeTruthy();

    // A read after the 201 answers 404 too: the confirmation stays.
    jest.mocked(apiGet).mockRejectedValue(new ApiError(404, "not_found"));
    await act(async () => {
      await client.fetchQuery(opportunityQueryOptions(DISPATCH_ID)).catch(() => undefined);
    });
    expect(screen.getByTestId("quote-sent")).toBeTruthy();
    expect(screen.queryByTestId("quote-closed-gone")).toBeNull();
    expect(router.dismissTo).not.toHaveBeenCalled();
  });

  it.each<[string, unknown]>([
    ["a network error", new NetworkError(false)],
    ["a 503", new ApiError(503, "unavailable")],
  ])(
    "the denial survives focus and a reopening with %s; only a fresh 200 lifts it",
    async (_, failure) => {
      jest.mocked(apiGet).mockRejectedValue(new ApiError(404, "not_found"));
      const client = seededClient();
      await renderWithQuery(<QuoteFormScreen />, client);
      await screen.findByTestId("quote-closed-gone");
      await waitFor(() =>
        expect(client.getQueryData(opportunityQueryKey(DISPATCH_ID))).toBeUndefined(),
      );
      await act(async () => navigation.setFocused(false));
      await act(async () => navigation.setFocused(true));
      await act(() => client.refetchQueries({ queryKey: opportunityQueryKey(DISPATCH_ID) }));
      expect(apiGet).toHaveBeenCalledTimes(1);
      expect(client.getQueryData(DENIED_KEY)).toEqual([DISPATCH_ID]);

      jest.mocked(apiGet).mockRejectedValue(failure);
      await screen.rerender(<QuoteFormScreen key="opened-again" />);
      await screen.findByTestId("quote-load-error");
      expect(screen.queryByTestId("quote-form")).toBeNull();
      expect(client.getQueryData(opportunityQueryKey(DISPATCH_ID))).toBeUndefined();
      expect(client.getQueryData(DENIED_KEY)).toEqual([DISPATCH_ID]);

      jest.mocked(apiGet).mockResolvedValue(detail({ description: "Fresh authorized body" }));
      await press("quote-load-error-action");
      await screen.findByTestId("quote-form");
      expect(client.getQueryData(DENIED_KEY)).toEqual([]);
      expect(client.getQueryData(opportunityQueryKey(DISPATCH_ID))).toHaveProperty(
        "description",
        "Fresh authorized body",
      );
      expect(screen.getByTestId("quote-price").props.value).toBe("");
    },
  );
});

const DENIED_KEY = ["opportunities-denied"];

/** The form over the detail it was pushed from, as the stack keeps them: one cache for both. */
async function renderStacked(client: QueryClient = seededClient()) {
  await renderWithQuery(
    <>
      <OpportunityDetailScreen />
      <QuoteFormScreen />
    </>,
    client,
  );
  await screen.findByTestId("quote-form");
  return client;
}

/** A read of the detail by another screen, answering `error`; later reads answer `then`. */
async function readFails(client: QueryClient, error: unknown, then: unknown) {
  jest.mocked(apiGet).mockRejectedValueOnce(error).mockRejectedValue(then);
  await act(async () => {
    await client.fetchQuery(opportunityQueryOptions(DISPATCH_ID)).catch(() => undefined);
  });
}

/** Nothing of the denied opportunity is left: not on screen, not in the cache, not listed. */
const leftOver = (client: QueryClient) => ({
  formShown: screen.queryByTestId("quote-form") !== null,
  reviewShown: screen.queryByTestId("quote-review-step") !== null,
  detailCached: client.getQueryData(opportunityQueryKey(DISPATCH_ID)) !== undefined,
  rowListed: listedIds(client).includes(DISPATCH_ID),
  denied: client.getQueryData(DENIED_KEY),
});
const NOTHING_LEFT = {
  formShown: false,
  reviewShown: false,
  detailCached: false,
  rowListed: false,
  denied: [DISPATCH_ID],
};

describe("QuoteFormScreen: denied while the quote is out", () => {
  it.each<[string, unknown]>([
    ["network", new NetworkError(false)],
    ["503", new ApiError(503, "unavailable")],
  ])("overwritten 404 during send then POST failure closes (%s)", async (_, failure) => {
    const client = await renderForm();
    await fillAndReview();
    const post = deferredPost();
    await press("quote-send");

    // Two reads by other screens land before the form draws again: it never sees the 404.
    jest
      .mocked(apiGet)
      .mockRejectedValueOnce(new ApiError(404, "not_found"))
      .mockRejectedValue(failure);
    await act(async () => {
      await client.fetchQuery(opportunityQueryOptions(DISPATCH_ID)).catch(() => undefined);
      await client.fetchQuery(opportunityQueryOptions(DISPATCH_ID)).catch(() => undefined);
    });

    // The quote waits for its answer, locked: the draft and the detail are gone at once.
    expect(screen.getByTestId("quote-review-step")).toBeTruthy();
    expect(screen.getByTestId("quote-edit")).toBeDisabled();
    await waitFor(() => expect(leftOver(client)).toMatchObject({ detailCached: false }));
    const reads = jest.mocked(apiGet).mock.calls.length;

    await act(async () => post.fail(new NetworkError(false)));
    expect(await screen.findByTestId("quote-closed-gone")).toBeTruthy();
    expect(leftOver(client)).toEqual(NOTHING_LEFT);
    expect(apiGet).toHaveBeenCalledTimes(reads);
  });

  it.each<[string, unknown, string]>([
    ["network", new NetworkError(false), "quote-closed-gone"],
    ["503", new ApiError(503, "unavailable"), "quote-closed-gone"],
    ["404", new ApiError(404, "not_found"), "quote-closed-gone"],
    ["409 not quotable", new ApiError(409, "not_quotable"), "quote-closed-gone"],
    ["409 quote exists", new ApiError(409, "quote_exists"), "quote-closed-alreadyQuoted"],
    ["422", new ApiError(422, "validation_error"), "quote-closed-gone"],
  ])(
    "stacked detail screen handles the 404 during send, POST fails, form closes (%s)",
    async (_, failure, closedID) => {
      const client = await renderStacked();
      await fillAndReview();
      const post = deferredPost();
      await press("quote-send");
      await readFails(client, new ApiError(404, "not_found"), new NetworkError(false));
      await waitFor(() => expect(client.getQueryData(DENIED_KEY)).toEqual([DISPATCH_ID]));
      await waitFor(() =>
        expect(client.getQueryData(opportunityQueryKey(DISPATCH_ID))).toBeUndefined(),
      );

      await act(async () => post.fail(failure));
      expect(await screen.findByTestId(closedID)).toBeTruthy();
      expect(screen.queryByTestId("quote-edit")).toBeNull();
      expect(screen.queryByTestId("quote-price")).toBeNull();
      expect(leftOver(client)).toEqual(NOTHING_LEFT);
      // Back goes home, not to the detail under it.
      expect(navigation.attemptLeave()).toBe(false);
      await waitFor(() => expect(router.dismissTo).toHaveBeenCalledWith("/"));
    },
  );

  it("stacked detail screen handles the 404 during send, then the 201 shows the confirmation", async () => {
    const client = await renderStacked();
    await fillAndReview();
    const post = deferredPost();
    await press("quote-send");
    await readFails(client, new ApiError(404, "not_found"), new NetworkError(false));
    await waitFor(() =>
      expect(client.getQueryData(opportunityQueryKey(DISPATCH_ID))).toBeUndefined(),
    );

    await act(async () => post.answer(sentQuote()));
    expect(await screen.findByTestId("quote-sent")).toBeTruthy();
    expect(screen.queryByTestId("quote-closed-gone")).toBeNull();
    expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith("Quote sent");
    expect(leftOver(client)).toEqual(NOTHING_LEFT);
    expect(navigation.attemptLeave()).toBe(false);
    await waitFor(() => expect(router.dismissTo).toHaveBeenCalledWith("/"));
  });

  it("a denial recorded on another screen during the send closes the form once the POST fails", async () => {
    const client = await renderForm();
    await fillAndReview();
    const post = deferredPost();
    await press("quote-send");
    const reads = jest.mocked(apiGet).mock.calls.length;

    // The form never sees this 404: the screen that got it forgot the query, error and all.
    await act(() => forgetOpportunity(client, DISPATCH_ID));
    expect(screen.getByTestId("quote-review-step")).toBeTruthy();
    expect(navigation.attemptLeave()).toBe(false);

    await act(async () => post.fail(new ApiError(503, "unavailable")));
    expect(await screen.findByTestId("quote-closed-gone")).toBeTruthy();
    expect(leftOver(client)).toEqual(NOTHING_LEFT);
    expect(apiGet).toHaveBeenCalledTimes(reads);
  });

  it("the draft goes with the denial: a later 200 elsewhere and a failed POST do not bring it back", async () => {
    const client = await renderForm();
    await fillAndReview();
    const post = deferredPost();
    await press("quote-send");
    await readFails(client, new ApiError(404, "not_found"), new NetworkError(false));
    await waitFor(() =>
      expect(client.getQueryData(opportunityQueryKey(DISPATCH_ID))).toBeUndefined(),
    );

    // Another screen gets a 200 for it while the quote is still out.
    jest.mocked(apiGet).mockResolvedValue(detail());
    await act(async () => {
      await client.fetchQuery(opportunityQueryOptions(DISPATCH_ID));
    });
    await act(async () => post.fail(new NetworkError(false)));

    expect(await screen.findByTestId("quote-closed-gone")).toBeTruthy();
    expect(screen.queryByTestId("quote-form")).toBeNull();
    expect(screen.queryByTestId("quote-review-step")).toBeNull();
    expect(screen.queryByTestId("quote-price")).toBeNull();
  });
});
