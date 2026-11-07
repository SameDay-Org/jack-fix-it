import i18n from "@/i18n";

import {
  initPaymentSheet,
  initStripe,
  PaymentSheetError,
  presentPaymentSheet,
} from "@stripe/stripe-react-native";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react-native";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { AccessibilityInfo } from "react-native";

import { apiGet, apiPost, ApiError, NetworkError } from "@/api";
import { dismissToast, toastStore } from "@/components/ui/toast";

import { deferred } from "../../../api/__tests__/helpers";
import {
  fakeClock,
  freezeClock,
  navigation,
  newQueryClient,
  quote,
  renderWithQuery,
  REQUEST_ID,
} from "../../quotes/__tests__/helpers";
import { paymentStore, type PaymentSheetOut } from "../paymentStore";
import {
  ACCEPT_PATH,
  ACCEPTED,
  api,
  App,
  callsTo,
  card,
  JOB,
  JOB_PATH,
  list,
  notFound,
  OTHER,
  PAYMENT_PATH,
  payTestId,
  QUOTE,
  resetPayments,
  routeApi,
  SECRETS,
  SHEET,
  signOut,
  type SessionDouble,
} from "./helpers";

jest.mock("@/api", () => {
  const session = { generation: 1, forget: new Set<() => void>() };
  return {
    ...jest.requireActual("../../../api/errors"),
    apiGet: jest.fn(),
    apiPost: jest.fn(),
    mockSession: session,
    onSignOut: (forget: () => void) => {
      session.forget.add(forget);
      return () => session.forget.delete(forget);
    },
    sessionGeneration: () => session.generation,
    isCurrentGeneration: (generation: number) => generation === session.generation,
  };
});
jest.mock("expo-router", () => jest.requireActual("../../quotes/__tests__/helpers").routerMock);
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);
// One instance for the component and the test (root __mocks__, see jest-root-mocks note).
jest.mock("@stripe/stripe-react-native");
jest.mock("expo-haptics");

const session = jest.requireMock<{ mockSession: SessionDouble }>("@/api").mockSession;
// Each test renders the whole quote screen and walks a payment through it, several steps of
// fetches and timers. Alone that takes about 1 s; under `pnpm -r test` contention one run went
// past Jest's 5 s default (the sign-out test), so these get the same room as the sign-up suite.
jest.setTimeout(30_000);

const PAY_NAME = "Pay $180.50 for the quote from María P.";
const payButton = () => screen.getByRole("button", { name: PAY_NAME });
const CONFIRMING = "Confirming your payment…";
const LOG_METHODS = ["log", "info", "warn", "error", "debug"] as const;

beforeEach(() => {
  freezeClock();
  navigation.reset();
  resetPayments();
  api.quotes = () => Promise.resolve(list([ACCEPTED, OTHER]));
  api.job = () => Promise.reject(notFound());
  api.accept = () => Promise.resolve(ACCEPTED);
  api.payment = () => Promise.resolve(SHEET);
  routeApi();
  jest.mocked(initStripe).mockReset().mockResolvedValue(undefined);
  jest.mocked(initPaymentSheet).mockReset().mockResolvedValue({});
  jest.mocked(presentPaymentSheet).mockReset().mockResolvedValue({});
  jest.mocked(Haptics.notificationAsync).mockClear();
  jest.mocked(router.back).mockClear();
  jest.mocked(AccessibilityInfo.announceForAccessibility).mockClear();
});

afterEach(async () => {
  dismissToast();
  jest.useRealTimers();
  await act(() => i18n.changeLanguage("en"));
});

/** Opens the screen with the accepted quote and waits for Pay (no job yet). */
async function openUnpaid(client = newQueryClient()) {
  const view = await renderWithQuery(<App />, client);
  await screen.findByRole("button", { name: PAY_NAME });
  return { ...view, client };
}

describe("paying an accepted quote", () => {
  it("accept, then the payment call, the sheet, the confirmation and You're booked", async () => {
    fakeClock();
    api.quotes = () => Promise.resolve(list([QUOTE, OTHER]));
    const client = newQueryClient();
    await renderWithQuery(<App />, client);
    await screen.findByText("$180.50");
    expect(callsTo(apiGet, JOB_PATH)).toHaveLength(0); // no accepted quote, no job to look up

    await fireEvent.press(
      screen.getByRole("button", { name: "Accept the quote from María P. for $180.50" }),
    );
    api.quotes = () => Promise.resolve(list([ACCEPTED, OTHER]));
    await fireEvent.press(screen.getByTestId("accept-quote-confirm"));

    // The sheet opens on its own once the request screen is back, in the confirm's session.
    await waitFor(() => expect(presentPaymentSheet).toHaveBeenCalledTimes(1));
    expect(router.back).toHaveBeenCalledTimes(1);
    expect(callsTo(apiPost, ACCEPT_PATH)).toHaveLength(1);
    expect(callsTo(apiPost, PAYMENT_PATH)).toEqual([
      [
        PAYMENT_PATH,
        undefined,
        { auth: true, generation: 1, params: { request_id: REQUEST_ID, quote_id: QUOTE.id } },
      ],
    ]);
    expect(initStripe).toHaveBeenCalledWith(
      expect.objectContaining({ publishableKey: "pk_test_jack", urlScheme: "jackfixit" }),
    );
    expect(initPaymentSheet).toHaveBeenCalledWith(
      expect.objectContaining({
        merchantDisplayName: "Jack Fix It",
        customerId: "cus_jack",
        customerEphemeralKeySecret: "ek_test_789",
        paymentIntentClientSecret: "pi_123_secret_456",
        allowsDelayedPaymentMethods: false,
        returnURL: expect.stringMatching(/^jackfixit:\/\/stripe-redirect$/),
        googlePay: { merchantCountryCode: "US", currencyCode: "USD", testEnv: true },
      }),
    );
    // Init before present, and the total said before the sheet covers the screen.
    expect(jest.mocked(initPaymentSheet).mock.invocationCallOrder[0]).toBeLessThan(
      jest.mocked(presentPaymentSheet).mock.invocationCallOrder[0],
    );
    expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith(
      "Total $180.50. Opening the secure payment.",
    );

    // Paid: the card confirms it, asking for the job every 2 s.
    const confirming = await screen.findByTestId(`${payTestId(QUOTE)}-confirming`);
    expect(within(confirming).getByText(CONFIRMING)).toBeTruthy();
    expect(within(confirming).getByText("This usually takes a few seconds.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: PAY_NAME })).toBeNull();
    const asked = callsTo(apiGet, JOB_PATH).length;
    expect(callsTo(apiGet, JOB_PATH).at(-1)?.[1]).toMatchObject({ auth: true, generation: 1 });
    await act(async () => jest.advanceTimersByTime(2_000));
    await waitFor(() => expect(callsTo(apiGet, JOB_PATH)).toHaveLength(asked + 1));

    api.job = () => Promise.resolve(JOB);
    await act(async () => jest.advanceTimersByTime(2_000));
    const booked = await screen.findByTestId(`${payTestId(QUOTE)}-booked`);
    expect(within(booked).getByText("You're booked")).toBeTruthy();
    expect(
      within(booked).getByText(/^Your service with María P\. is set for [A-Z][a-z]{2}, /),
    ).toBeTruthy();
    expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith(
      "You're booked. Your payment is confirmed.",
    );
    expect(Haptics.notificationAsync).toHaveBeenCalledWith(
      Haptics.NotificationFeedbackType.Success,
    );

    // Booked ends the polling, and the sheet was opened once.
    const total = callsTo(apiGet, JOB_PATH).length;
    await act(async () => jest.advanceTimersByTime(10_000));
    expect(callsTo(apiGet, JOB_PATH)).toHaveLength(total);
    expect(presentPaymentSheet).toHaveBeenCalledTimes(1);
    expect(paymentStore.getState().confirming).toEqual({});
  });

  it("the accepted card shows Pay while there is no job and pays from there", async () => {
    const job = deferred<typeof JOB>();
    api.job = () => job.promise;
    const view = await renderWithQuery(<App />);
    // While the job is first looked up, a pill-shaped placeholder holds Pay's place.
    await screen.findByTestId(`${payTestId(ACCEPTED)}-pay-placeholder`);
    // A paid quote could be behind it: nothing says payment comes next yet.
    expect(
      screen.queryByText("Quote accepted. Payment comes next.", { includeHiddenElements: true }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: PAY_NAME })).toBeNull();
    await act(async () => job.reject(notFound()));
    await screen.findByRole("button", { name: PAY_NAME });
    expect(card(ACCEPTED).getByText("Pay $180.50")).toBeTruthy();
    expect(
      card(ACCEPTED).getByText("Quote accepted. Payment comes next.", {
        includeHiddenElements: true,
      }),
    ).toBeTruthy();
    // Opening the screen never opens the sheet: only an accept or Pay does.
    expect(apiPost).not.toHaveBeenCalled();
    expect(presentPaymentSheet).not.toHaveBeenCalled();

    jest.mocked(presentPaymentSheet).mockResolvedValue({
      error: { code: PaymentSheetError.Canceled, message: "The payment flow has been canceled" },
    });
    const answer = deferred<PaymentSheetOut>();
    api.payment = () => answer.promise;
    // A second tap while the first is under way is ignored.
    await act(async () => fireEvent.press(payButton()));
    const busy = screen.getByTestId(`${payTestId(ACCEPTED)}-pay`);
    expect(busy.props.accessibilityState).toMatchObject({ busy: true });
    await act(async () => fireEvent.press(busy));
    await act(async () => answer.resolve(SHEET));
    await waitFor(() => expect(presentPaymentSheet).toHaveBeenCalledTimes(1));
    expect(callsTo(apiPost, PAYMENT_PATH)).toHaveLength(1);
    expect(card(ACCEPTED).getByText("Total $180.50")).toBeTruthy();
    await view.unmount();
  });

  it("a total with tax shows the price and the tax under it; no tax shows no line", async () => {
    api.payment = () =>
      Promise.resolve({ ...SHEET, tax_cents: 1_444, customer_total_cents: 19_494 });
    jest.mocked(presentPaymentSheet).mockResolvedValue({
      error: { code: PaymentSheetError.Canceled, message: "canceled" },
    });
    await openUnpaid();
    await act(async () => fireEvent.press(payButton()));

    const total = await screen.findByTestId(`${payTestId(ACCEPTED)}-total`);
    expect(total.props.accessibilityLabel).toBe("Total $194.94, $180.50 plus $14.44 tax");
    expect(screen.getByText("$180.50 plus $14.44 tax")).toBeTruthy();
    // Pay now says what the sheet will charge.
    expect(screen.getByText("Pay $194.94")).toBeTruthy();
  });

  it("canceling the sheet goes back to Pay with no error and no toast", async () => {
    jest.mocked(presentPaymentSheet).mockResolvedValue({
      error: { code: PaymentSheetError.Canceled, message: "The payment flow has been canceled" },
    });
    await openUnpaid();
    await act(async () => fireEvent.press(payButton()));
    await waitFor(() => expect(presentPaymentSheet).toHaveBeenCalledTimes(1));

    await waitFor(() =>
      expect(payButton().props.accessibilityState).toMatchObject({ busy: false }),
    );
    expect(screen.queryByTestId(`${payTestId(ACCEPTED)}-failure`)).toBeNull();
    expect(screen.queryByText(CONFIRMING)).toBeNull();
    expect(toastStore.getState().current).toBeNull();
    expect(paymentStore.getState().confirming).toEqual({});
  });

  it.each([
    [
      "the sheet's Failed",
      () =>
        jest.mocked(presentPaymentSheet).mockResolvedValue({
          error: { code: PaymentSheetError.Failed, message: "Your card 4000 0000 0000 9995 ..." },
        }),
      "Your payment didn't go through",
      "Try again, or use another card or payment method.",
    ],
    [
      "the sheet's Timeout",
      () =>
        jest.mocked(presentPaymentSheet).mockResolvedValue({
          error: { code: PaymentSheetError.Timeout, message: "Timed out for jane@example.com" },
        }),
      "The payment took too long",
      "Please try again.",
    ],
    [
      "an init error",
      () =>
        jest.mocked(initPaymentSheet).mockResolvedValue({
          error: { code: PaymentSheetError.Failed, message: "No such customer: cus_jack" },
        }),
      "We couldn't open the payment",
      "Please try again in a moment.",
    ],
    [
      "initStripe rejecting",
      () => jest.mocked(initStripe).mockRejectedValue(new Error("Invalid key pk_test_jack")),
      "We couldn't open the payment",
      "Please try again in a moment.",
    ],
  ])(
    "%s says so calmly from its code, never its message, and Pay stays",
    async (_, arrange, title, body) => {
      arrange();
      await openUnpaid();
      await act(async () => fireEvent.press(payButton()));

      const failure = await screen.findByTestId(`${payTestId(ACCEPTED)}-failure`);
      expect(within(failure).getByText(title)).toBeTruthy();
      expect(within(failure).getByText(body)).toBeTruthy();
      expect(failure.props.accessibilityRole).toBe("alert");
      expect(screen.queryByText(/4000|jane@|cus_jack|pk_test/)).toBeNull();
      expect(payButton().props.accessibilityState).toMatchObject({ busy: false });
      expect(paymentStore.getState().confirming).toEqual({});

      // Paying again clears the notice while it runs.
      jest.mocked(presentPaymentSheet).mockResolvedValue({});
      jest.mocked(initPaymentSheet).mockResolvedValue({});
      jest.mocked(initStripe).mockResolvedValue(undefined);
      await act(async () => fireEvent.press(payButton()));
      await screen.findByText(CONFIRMING);
      expect(screen.queryByTestId(`${payTestId(ACCEPTED)}-failure`)).toBeNull();
    },
  );

  it.each([
    [
      "409 pro_not_hireable",
      new ApiError(409, "pro_not_hireable"),
      "This pro can't take payments right now",
      true,
      true,
    ],
    [
      "409 payment_needs_review",
      new ApiError(409, "payment_needs_review"),
      "We're checking your payment",
      false,
      true,
    ],
    [
      "503 not_configured",
      new ApiError(503, "not_configured"),
      "Payments aren't available yet",
      false,
      true,
    ],
    [
      "503 payments_unavailable",
      new ApiError(503, "payments_unavailable"),
      "We couldn't start the payment",
      false,
      false,
    ],
    [
      "502 payments_error",
      new ApiError(502, "payments_error"),
      "We couldn't start the payment",
      false,
      false,
    ],
    ["no connection", new NetworkError(false), "No connection", false, false],
    ["a timeout", new NetworkError(true), "No connection", false, false],
  ])("%s opens no sheet and says so in the card", async (_, error, title, refetches, calm) => {
    api.payment = () => Promise.reject(error);
    await openUnpaid();
    const quoteFetches = callsTo(apiGet, "/v1/requests/{request_id}/quotes").length;
    await act(async () => fireEvent.press(payButton()));

    const failure = await screen.findByTestId(`${payTestId(ACCEPTED)}-failure`);
    expect(within(failure).getByText(title)).toBeTruthy();
    // Nothing for the customer to fix reads calm (info); a failure to connect is the danger tint.
    expect(failure.props.className).toContain(calm ? "bg-navy-900/5" : "bg-danger/10");
    expect(initStripe).not.toHaveBeenCalled();
    expect(initPaymentSheet).not.toHaveBeenCalled();
    expect(presentPaymentSheet).not.toHaveBeenCalled();
    expect(toastStore.getState().current).toBeNull();
    expect(payButton()).toBeTruthy();
    const quoteCalls = () => callsTo(apiGet, "/v1/requests/{request_id}/quotes").length;
    if (refetches) await waitFor(() => expect(quoteCalls()).toBeGreaterThan(quoteFetches));
    else expect(quoteCalls()).toBe(quoteFetches);
  });

  it.each([
    ["409 payment_not_available", new ApiError(409, "payment_not_available")],
    ["404 (the quote is gone)", new ApiError(404, "not_found")],
  ])("%s refetches the quotes and the job and says so in a toast", async (_, error) => {
    api.payment = () => Promise.reject(error);
    await openUnpaid();
    const quoteFetches = callsTo(apiGet, "/v1/requests/{request_id}/quotes").length;
    const jobFetches = callsTo(apiGet, JOB_PATH).length;
    // The quote was paid elsewhere meanwhile: the refetch finds the job.
    api.job = () => Promise.resolve(JOB);
    await act(async () => fireEvent.press(payButton()));

    await waitFor(() =>
      expect(toastStore.getState().current).toMatchObject({
        message: "This quote can't be paid right now. Your quotes are up to date.",
        tone: "danger",
      }),
    );
    await waitFor(() =>
      expect(callsTo(apiGet, "/v1/requests/{request_id}/quotes").length).toBeGreaterThan(
        quoteFetches,
      ),
    );
    await waitFor(() => expect(callsTo(apiGet, JOB_PATH).length).toBeGreaterThan(jobFetches));
    await screen.findByTestId(`${payTestId(ACCEPTED)}-booked`);
    expect(presentPaymentSheet).not.toHaveBeenCalled();
    expect(screen.queryByTestId(`${payTestId(ACCEPTED)}-failure`)).toBeNull();
  });

  it("an existing job shows You're booked and no Pay", async () => {
    api.job = () => Promise.resolve(JOB);
    await renderWithQuery(<App />);
    await screen.findByTestId(`${payTestId(ACCEPTED)}-booked`);
    expect(screen.queryByRole("button", { name: PAY_NAME })).toBeNull();
    expect(apiPost).not.toHaveBeenCalled();
    // Not a payment that just landed: nothing is announced or felt.
    expect(AccessibilityInfo.announceForAccessibility).not.toHaveBeenCalledWith(
      "You're booked. Your payment is confirmed.",
    );
    expect(Haptics.notificationAsync).not.toHaveBeenCalled();
  });

  it("a job past Scheduled shows its status from the glossary, with no planned date", async () => {
    api.job = () => Promise.resolve({ ...JOB, status: "on_the_way" });
    await renderWithQuery(<App />);
    const booked = await screen.findByTestId(`${payTestId(ACCEPTED)}-booked`);
    expect(within(booked).getByText("Professional On The Way")).toBeTruthy();
    expect(within(booked).queryByText(/is set for/)).toBeNull();
    expect(screen.queryByRole("button", { name: PAY_NAME })).toBeNull();
  });

  it("a job lookup that fails still offers Pay (paying again is safe)", async () => {
    api.job = () => Promise.reject(new NetworkError(false));
    await openUnpaid();
    expect(payButton()).toBeTruthy();
  });

  it("speaks Spanish", async () => {
    await act(() => i18n.changeLanguage("es"));
    api.payment = () => Promise.reject(new ApiError(409, "payment_needs_review"));
    await renderWithQuery(<App />);
    const pay = await screen.findByRole("button", {
      name: "Pagar 180,50 US$ por el presupuesto de María P.",
    });
    await act(async () => fireEvent.press(pay));
    expect(await screen.findByText("Estamos revisando tu pago")).toBeTruthy();
    expect(screen.getByText("Inténtalo de nuevo en unos minutos.")).toBeTruthy();
  });
});

describe("the session pin", () => {
  it("a payment answer that lands after a sign-out opens no sheet", async () => {
    const answer = deferred<PaymentSheetOut>();
    api.payment = () => answer.promise;
    const { client } = await openUnpaid();
    await act(async () => fireEvent.press(payButton()));
    await waitFor(() => expect(callsTo(apiPost, PAYMENT_PATH)).toHaveLength(1));

    await signOut(session, client);
    await act(async () => answer.resolve(SHEET));

    expect(initStripe).not.toHaveBeenCalled();
    expect(initPaymentSheet).not.toHaveBeenCalled();
    expect(presentPaymentSheet).not.toHaveBeenCalled();
    expect(paymentStore.getState().summaries).toEqual({});
    expect(AccessibilityInfo.announceForAccessibility).not.toHaveBeenCalledWith(
      expect.stringMatching(/^Total /),
    );
    session.generation = 1;
  });

  it("a sign-out while the sheet initializes keeps it from being presented", async () => {
    const init = deferred<Awaited<ReturnType<typeof initPaymentSheet>>>();
    jest.mocked(initPaymentSheet).mockReturnValue(init.promise);
    const { client } = await openUnpaid();
    await act(async () => fireEvent.press(payButton()));
    await waitFor(() => expect(initPaymentSheet).toHaveBeenCalledTimes(1));

    await signOut(session, client);
    await act(async () => init.resolve({}));

    expect(presentPaymentSheet).not.toHaveBeenCalled();
    session.generation = 1;
  });

  it("a payment reported after a sign-out starts no confirmation for the next session", async () => {
    const present = deferred<Awaited<ReturnType<typeof presentPaymentSheet>>>();
    jest.mocked(presentPaymentSheet).mockReturnValue(present.promise);
    const { client } = await openUnpaid();
    await act(async () => fireEvent.press(payButton()));
    await waitFor(() => expect(presentPaymentSheet).toHaveBeenCalledTimes(1));

    await signOut(session, client);
    await act(async () => present.resolve({}));

    expect(paymentStore.getState().confirming).toEqual({});
    expect(screen.queryByText(CONFIRMING)).toBeNull();
    session.generation = 1;
  });

  it("an accept handed over before a sign-out pays nothing", async () => {
    api.quotes = () => Promise.resolve(list([QUOTE, OTHER]));
    const answer = deferred<typeof ACCEPTED>();
    api.accept = () => answer.promise;
    const client = newQueryClient();
    await renderWithQuery(<App />, client);
    await fireEvent.press(
      await screen.findByRole("button", { name: "Accept the quote from María P. for $180.50" }),
    );
    await fireEvent.press(screen.getByTestId("accept-quote-confirm"));
    await waitFor(() => expect(callsTo(apiPost, ACCEPT_PATH)).toHaveLength(1));

    // The session ends while the accept is in flight; its 200 lands for the old session.
    session.generation += 1;
    api.quotes = () => Promise.resolve(list([ACCEPTED, OTHER]));
    await act(async () => answer.resolve(ACCEPTED));
    await screen.findByRole("button", { name: PAY_NAME });

    expect(callsTo(apiPost, PAYMENT_PATH)).toHaveLength(0);
    expect(presentPaymentSheet).not.toHaveBeenCalled();
    session.generation = 1;
  });

  it("a sign-out forgets the summary and the confirmation", async () => {
    const { client } = await openUnpaid();
    await act(async () => fireEvent.press(payButton()));
    await screen.findByText(CONFIRMING);
    expect(Object.keys(paymentStore.getState().summaries)).toEqual([ACCEPTED.id]);

    await signOut(session, client);
    expect(paymentStore.getState()).toEqual({ autoPay: null, summaries: {}, confirming: {} });
    session.generation = 1;
  });
});

describe("the confirmation", () => {
  async function paidAndConfirming() {
    fakeClock();
    const view = await openUnpaid();
    await act(async () => fireEvent.press(payButton()));
    await screen.findByText(CONFIRMING);
    await waitFor(() => expect(callsTo(apiGet, JOB_PATH).length).toBeGreaterThan(1));
    return view;
  }

  it("stops asking while the screen is out of focus and asks again when it is back", async () => {
    await paidAndConfirming();
    const asked = callsTo(apiGet, JOB_PATH).length;

    await act(async () => navigation.setFocused(false));
    await act(async () => jest.advanceTimersByTime(10_000));
    expect(callsTo(apiGet, JOB_PATH)).toHaveLength(asked);

    await act(async () => navigation.setFocused(true));
    await waitFor(() => expect(callsTo(apiGet, JOB_PATH).length).toBeGreaterThan(asked));
    const back = callsTo(apiGet, JOB_PATH).length;
    await act(async () => jest.advanceTimersByTime(2_000));
    await waitFor(() => expect(callsTo(apiGet, JOB_PATH).length).toBeGreaterThan(back));
  });

  it("stops asking once the card is gone", async () => {
    const view = await paidAndConfirming();
    await view.unmount();
    const asked = callsTo(apiGet, JOB_PATH).length;
    await act(async () => jest.advanceTimersByTime(10_000));
    expect(callsTo(apiGet, JOB_PATH)).toHaveLength(asked);
  });

  it("stops asking after a sign-out", async () => {
    const { client } = await paidAndConfirming();
    const before = callsTo(apiGet, JOB_PATH).length;
    await signOut(session, client);
    await act(async () => jest.advanceTimersByTime(10_000));
    // The cleared cache may reload the card's job once for the new session (its screens replace
    // this one in the app); the old session's polling never sends again.
    const after = callsTo(apiGet, JOB_PATH).slice(before);
    expect(after.length).toBeLessThanOrEqual(1);
    expect(after.filter(([, options]) => options?.generation === 1)).toEqual([]);
    session.generation = 1;
  });

  it("after the wait it says calmly that the payment is being confirmed, and offers no retry", async () => {
    await paidAndConfirming();
    await act(async () => jest.advanceTimersByTime(60_000));

    const delayed = await screen.findByTestId(`${payTestId(ACCEPTED)}-delayed`);
    expect(within(delayed).getByText("We're confirming your payment")).toBeTruthy();
    expect(
      within(delayed).getByText("This can take a little longer. Check back here soon."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: PAY_NAME })).toBeNull();
    const asked = callsTo(apiGet, JOB_PATH).length;
    await act(async () => jest.advanceTimersByTime(10_000));
    expect(callsTo(apiGet, JOB_PATH)).toHaveLength(asked);

    // A later return to the screen still finds the job.
    api.job = () => Promise.resolve(JOB);
    await act(async () => navigation.setFocused(false));
    await act(async () => navigation.setFocused(true));
    await screen.findByTestId(`${payTestId(ACCEPTED)}-booked`);
  });

  it("a card that remounts after the wait ran out shows the calm message from its first frame", async () => {
    const view = await paidAndConfirming();
    await act(async () => jest.advanceTimersByTime(60_000));
    await screen.findByTestId(`${payTestId(ACCEPTED)}-delayed`);
    await view.unmount();
    jest.mocked(AccessibilityInfo.announceForAccessibilityWithOptions).mockClear();

    await renderWithQuery(<App />);
    await screen.findByTestId(`${payTestId(ACCEPTED)}-delayed`);
    expect(screen.queryByText(CONFIRMING)).toBeNull();
    const shown = jest
      .mocked(AccessibilityInfo.announceForAccessibilityWithOptions)
      .mock.calls.map(([message]) => message);
    expect(shown.filter((message) => message.startsWith(CONFIRMING)).length).toBe(0);
  });

  it("a card that remounts while confirming keeps confirming", async () => {
    const view = await paidAndConfirming();
    await view.unmount();
    await renderWithQuery(<App />);
    expect(await screen.findByText(CONFIRMING)).toBeTruthy();
  });
});

describe("secrets", () => {
  it("no log call ever carries the client secret, the ephemeral key, the key or the customer", async () => {
    const spies = LOG_METHODS.map((method) =>
      jest.spyOn(console, method).mockImplementation(() => undefined),
    );
    try {
      fakeClock();
      api.quotes = () => Promise.resolve(list([QUOTE, OTHER]));
      await renderWithQuery(<App />);
      await fireEvent.press(
        await screen.findByRole("button", { name: "Accept the quote from María P. for $180.50" }),
      );
      api.quotes = () => Promise.resolve(list([ACCEPTED, OTHER]));
      await fireEvent.press(screen.getByTestId("accept-quote-confirm"));
      await screen.findByText(CONFIRMING);
      api.job = () => Promise.resolve(JOB);
      await act(async () => jest.advanceTimersByTime(2_000));
      await screen.findByTestId(`${payTestId(QUOTE)}-booked`);

      const logged = spies.flatMap((spy) => spy.mock.calls).map((args) => JSON.stringify(args));
      for (const secret of SECRETS) {
        expect(logged.filter((line) => line.includes(secret))).toEqual([]);
      }
      const announced = jest
        .mocked(AccessibilityInfo.announceForAccessibility)
        .mock.calls.map((args) => JSON.stringify(args));
      for (const secret of SECRETS) {
        expect(announced.filter((line) => line.includes(secret))).toEqual([]);
      }
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
  });
});

// Keeps the fixture honest: another pending quote is listed and has no payment.
it("only the accepted quote's card has a payment", async () => {
  await openUnpaid();
  expect(screen.queryByTestId(payTestId(OTHER))).toBeNull();
  expect(screen.queryByTestId(payTestId(quote(3)))).toBeNull();
});
