import "@/i18n";

import type { QueryClient } from "@tanstack/react-query";
import { fireEvent, screen, waitFor } from "@testing-library/react-native";
import { router } from "expo-router";
import { AccessibilityInfo, Alert, type AlertButton } from "react-native";

import { ApiError, apiGet, apiPost, NetworkError } from "@/api";

import { flattenOpportunities, OPPORTUNITIES_QUERY_KEY } from "../../pro-home/useOpportunities";
import { QuoteFormScreen } from "../QuoteFormScreen";
import { opportunityQueryKey } from "../useOpportunity";
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

const alertButtons = (): AlertButton[] => jest.mocked(Alert.alert).mock.calls[0]?.[2] ?? [];

beforeEach(() => {
  freezeClock();
  navigation.reset();
  navigation.dispatch.mockClear();
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

    for (const invalid of ["abc", "100.555", "0", ""]) {
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
    expect(screen.getByTestId("quote-price").props.value).toBe("1,000.50");

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
    expect(navigation.dispatch).not.toHaveBeenCalled();
    discard?.onPress?.();
    expect(navigation.dispatch).toHaveBeenCalledWith(GO_BACK);
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
    await renderWithQuery(<QuoteFormScreen />, newQueryClient());
    expect(screen.getByTestId("quote-loading")).toBeTruthy();
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
