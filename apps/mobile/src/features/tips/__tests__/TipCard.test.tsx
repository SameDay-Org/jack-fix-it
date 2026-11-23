import "@/i18n";

import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react-native";
import * as Haptics from "expo-haptics";
import type { ReactNode } from "react";

import { ApiError, apiGet, apiPost, NetworkError } from "@/api";
import { customerJobQueryOptions } from "@/features/jobs/api";
import type { CustomerJob } from "@/features/jobs/phase";
import { paymentConfig } from "@/features/payments/config";
import { openPaymentSheet } from "@/features/payments/paymentSheet";

import { confirmedJob } from "../../jobs/__tests__/helpers";
import type { TipOut, TipStatus } from "../api";
import { TipCard } from "../TipCard";
import { useTip } from "../useTip";

jest.mock("@/api", () => ({
  ...jest.requireActual("../../../api/errors"),
  apiGet: jest.fn(),
  apiPost: jest.fn(),
  sessionGeneration: () => 1,
  isCurrentGeneration: (generation: number) => generation === 1,
  useSessionGeneration: () => 1,
  // The payment store and the sheet lock forget everything on a sign-out (not exercised here).
  onSignOut: () => () => undefined,
  beforeSignOut: () => () => undefined,
}));
// Stripe's sheet has its own tests (features/payments): here it reports how it ended.
jest.mock("@/features/payments/paymentSheet", () => ({ openPaymentSheet: jest.fn() }));
jest.mock("expo-haptics", () => ({
  notificationAsync: jest.fn(async () => undefined),
  NotificationFeedbackType: { Success: "success" },
}));

const REQUEST_ID = "6f1c2a40-0000-4000-8000-000000000273";
const TIP_PATH = "/v1/requests/{request_id}/job/tip";
const JOB_PATH = "/v1/requests/{request_id}/job";
const SHEET = {
  payment_intent_client_secret: "pi_tip_secret",
  customer_id: "cus_1",
  customer_session_client_secret: "cuss_1",
  ephemeral_key_secret: "ek_1",
  publishable_key: "pk_test_1",
  amount_cents: 999,
  tax_cents: 0,
  customer_total_cents: 999,
  currency: "usd",
};

/**
 * The server's options. The amounts are deliberately NOT the percent of the job's $180.00: the
 * card shows what the server computed and computes nothing itself.
 */
const tipOut = (overrides: Partial<TipOut> = {}): TipOut => ({
  status: null,
  choice: null,
  percent: null,
  amount_cents: 0,
  currency: "usd",
  options: {
    presets: [
      { percent: 5, amount_cents: 901 },
      { percent: 10, amount_cents: 999 },
      { percent: 15, amount_cents: 2701 },
    ],
    min_cents: 100,
    max_cents: 18_000,
  },
  can_tip: true,
  closes_at: "2026-11-26T14:00:00Z",
  ...overrides,
});

const withTip = (tip: TipOut | null): CustomerJob =>
  ({ ...confirmedJob(), tip }) as unknown as CustomerJob;

/** The job the server answers now (the card's truth after each read). */
let serverJob: CustomerJob = withTip(tipOut());

function Host() {
  // As the job screen does: the card gets the job the cache holds.
  const { data } = useQuery(customerJobQueryOptions(REQUEST_ID, 1));
  return data ? <TipCard requestId={REQUEST_ID} job={data} /> : null;
}

async function renderCard(tip: TipOut | null = tipOut()) {
  serverJob = withTip(tip);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await render(
    <QueryClientProvider client={client}>
      <Host />
    </QueryClientProvider>,
  );
  // The job's first read and TanStack's batched notifications run on (fake) timers.
  await act(async () => {
    await jest.runOnlyPendingTimersAsync();
  });
  return client;
}

const answer = (status: TipStatus | null, patch: Partial<TipOut> = {}) => {
  serverJob = withTip(tipOut({ status, ...patch }));
};
/** Lets TanStack's batched cache notifications (on fake timers) reach the card. */
const flush = () =>
  act(async () => {
    await jest.runOnlyPendingTimersAsync();
  });
/**
 * One more fake millisecond: enough for a cache notification, without draining the poll's and the
 * wait's timers (they re-arm while the card waits, so draining them never ends).
 */
const tick = () =>
  act(async () => {
    await jest.advanceTimersByTimeAsync(1);
  });
const chip = (name: string) => screen.getByRole("radio", { name });
const payButton = () => screen.getByTestId("tip-pay");
const tipCalls = () => jest.mocked(apiPost).mock.calls.filter(([path]) => path === TIP_PATH);
/** The Idempotency-Key each tip call carried, in order. */
const sentKeys = () =>
  tipCalls().map((call) => (call[2] as { idempotencyKey?: string } | undefined)?.idempotencyKey);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
  jest.mocked(apiGet).mockReset();
  jest.mocked(apiGet).mockImplementation((async (path: string) => {
    if (path === JOB_PATH) return serverJob;
    throw new Error(`unexpected GET ${path}`);
  }) as unknown as typeof apiGet);
  jest.mocked(apiPost).mockReset();
  jest.mocked(openPaymentSheet).mockReset();
  jest.mocked(Haptics.notificationAsync).mockClear();
});

afterEach(() => jest.useRealTimers());

describe("TipCard (#273)", () => {
  it("asks without pressure: the server's amounts, nothing chosen, no button until a choice", async () => {
    await renderCard();

    expect(screen.getByRole("header", { name: "Add a tip for Dan?" })).toBeTruthy();
    expect(screen.getByText("Tips are optional. Dan gets 100% of it.")).toBeTruthy();
    expect(screen.getByLabelText("Tip amount").props.accessibilityRole).toBe("radiogroup");
    // The server's amounts, not 5/10/15% of $180.00 ($9.00, $18.00, $27.00).
    for (const name of ["5% · $9.01", "10% · $9.99", "15% · $27.01", "Custom"]) {
      expect(chip(name).props.accessibilityState).toMatchObject({ checked: false });
    }
    expect(screen.getByRole("button", { name: "No tip" })).toBeTruthy();
    expect(screen.queryByTestId("tip-pay")).toBeNull();
  });

  it.each([
    ["no tip on the job", null],
    ["the window closed", tipOut({ can_tip: false })],
  ])("shows nothing with %s", async (_, tip) => {
    await renderCard(tip);
    expect(screen.queryByTestId("tip-card")).toBeNull();
  });

  it("a preset pays the server's amount through the sheet, then says thanks once the tip lands", async () => {
    await renderCard();
    jest.mocked(apiPost).mockImplementation((async () => {
      answer("requires_payment", { choice: "percent", percent: 10, amount_cents: 999 });
      return { tip: tipOut({ status: "requires_payment", amount_cents: 999 }), sheet: SHEET };
    }) as unknown as typeof apiPost);
    jest.mocked(openPaymentSheet).mockResolvedValue({ kind: "paid" });

    await act(async () => fireEvent.press(chip("10% · $9.99")));
    expect(payButton()).toHaveTextContent("Tip $9.99");
    await act(async () => fireEvent.press(payButton()));

    expect(tipCalls()).toEqual([
      [
        TIP_PATH,
        { choice: "percent", percent: 10 },
        {
          auth: true,
          generation: 1,
          idempotencyKey: expect.stringMatching(UUID),
          params: { request_id: REQUEST_ID },
        },
      ],
    ]);
    expect(jest.mocked(openPaymentSheet).mock.calls[0]?.[0]).toBe(SHEET);
    // Paid in the sheet; the API's answer is not on the job yet: the card waits, busy.
    expect(payButton().props.accessibilityState).toMatchObject({ busy: true });

    answer("succeeded", { choice: "percent", percent: 10, amount_cents: 999, can_tip: false });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(5_000);
    });
    await tick();
    expect(screen.getByTestId("tip-done")).toHaveTextContent("You tipped Dan $9.99. Thank you!");
    expect(Haptics.notificationAsync).toHaveBeenCalledTimes(1);
  });

  it("a refused card keeps the job confirmed and offers the choice again", async () => {
    await renderCard();
    jest.mocked(apiPost).mockResolvedValue({
      tip: tipOut({ status: "requires_payment" }),
      sheet: SHEET,
    } as never);
    jest.mocked(openPaymentSheet).mockResolvedValue({ kind: "failed", reason: "failed" });

    await act(async () => fireEvent.press(chip("5% · $9.01")));
    await act(async () => fireEvent.press(payButton()));

    expect(screen.getByTestId("tip-failed")).toHaveTextContent(
      "The tip didn't go through. Your job is still confirmed.",
    );
    expect(payButton().props.accessibilityState).toMatchObject({ disabled: false });
    // Only the tip was asked for: nothing about the job's confirmation moved.
    expect(jest.mocked(apiPost).mock.calls.every(([path]) => path === TIP_PATH)).toBe(true);
  });

  it("the API reporting the tip failed after the sheet says so the same calm way", async () => {
    await renderCard();
    jest.mocked(apiPost).mockImplementation((async () => {
      answer("requires_payment");
      return { tip: tipOut({ status: "requires_payment" }), sheet: SHEET };
    }) as unknown as typeof apiPost);
    jest.mocked(openPaymentSheet).mockResolvedValue({ kind: "paid" });

    await act(async () => fireEvent.press(chip("15% · $27.01")));
    await act(async () => fireEvent.press(payButton()));
    answer("failed");
    await act(async () => {
      await jest.advanceTimersByTimeAsync(5_000);
    });

    await tick();
    expect(screen.getByTestId("tip-failed")).toHaveTextContent(
      "The tip didn't go through. Your job is still confirmed.",
    );
    expect(screen.queryByTestId("tip-done")).toBeNull();
  });

  it("No tip sends none once and the card becomes one quiet line", async () => {
    await renderCard();
    jest.mocked(apiPost).mockImplementation((async () => {
      answer("declined", { choice: "none" });
      return { tip: tipOut({ status: "declined", choice: "none" }), sheet: null };
    }) as unknown as typeof apiPost);

    await act(async () => fireEvent.press(screen.getByRole("button", { name: "No tip" })));
    await flush();

    expect(tipCalls()).toHaveLength(1);
    expect(tipCalls()[0]?.[1]).toEqual({ choice: "none" });
    expect(openPaymentSheet).not.toHaveBeenCalled();
    expect(screen.getByTestId("tip-skipped")).toHaveTextContent("No tip added");
  });

  it("a custom amount is checked against the server's bounds before any request", async () => {
    await renderCard();
    jest.mocked(apiPost).mockResolvedValue({
      tip: tipOut({ status: "requires_payment" }),
      sheet: SHEET,
    } as never);
    jest.mocked(openPaymentSheet).mockResolvedValue({ kind: "canceled" });

    await act(async () => fireEvent.press(chip("Custom")));
    const field = screen.getByTestId("tip-custom-amount");
    expect(within(screen.getByTestId("tip-card")).getByText("From $1.00 to $180.00")).toBeTruthy();

    await act(async () => fireEvent.changeText(field, "200"));
    await act(async () => fireEvent.press(payButton()));
    expect(screen.getByText("Enter an amount from $1.00 to $180.00.")).toBeTruthy();

    await act(async () => fireEvent.changeText(field, "abc"));
    await act(async () => fireEvent.press(payButton()));
    expect(screen.getByText("Enter an amount, like 10 or 12.50.")).toBeTruthy();
    expect(tipCalls()).toHaveLength(0);

    await act(async () => fireEvent.changeText(field, "12.5"));
    expect(payButton()).toHaveTextContent("Tip $12.50");
    await act(async () => fireEvent.press(payButton()));
    expect(tipCalls()[0]?.[1]).toEqual({ choice: "custom", amount_cents: 1250 });
    // Closed the sheet: back to the choice, as it was.
    expect(screen.queryByTestId("tip-failed")).toBeNull();
    expect(field.props.value).toBe("12.5");
  });

  it("offline says so and keeps the job confirmed", async () => {
    await renderCard();
    jest.mocked(apiPost).mockRejectedValue(new NetworkError(false));

    await act(async () => fireEvent.press(chip("10% · $9.99")));
    await act(async () => fireEvent.press(payButton()));

    expect(screen.getByTestId("tip-failed")).toHaveTextContent(
      "You're offline. Your job is still confirmed; try the tip again when you're back online.",
    );
  });

  it("a closed window or a tip already paid asks for the job again instead of failing", async () => {
    await renderCard();
    jest.mocked(apiPost).mockRejectedValue(new ApiError(409, "tip_not_available"));
    const reads = () => jest.mocked(apiGet).mock.calls.length;
    const before = reads();

    answer(null, { can_tip: false });
    await act(async () => fireEvent.press(chip("5% · $9.01")));
    await act(async () => fireEvent.press(payButton()));

    await waitFor(() => expect(reads()).toBeGreaterThan(before));
    await waitFor(() => expect(screen.queryByTestId("tip-card")).toBeNull());
    expect(screen.queryByTestId("tip-failed")).toBeNull();
  });

  it("a retry of an unanswered choice carries its key again; an answer or a new choice gets a new one", async () => {
    await renderCard();
    jest.mocked(apiPost).mockRejectedValueOnce(new NetworkError(false));
    jest.mocked(apiPost).mockResolvedValue({
      tip: tipOut({ status: "requires_payment" }),
      sheet: SHEET,
    } as never);
    jest.mocked(openPaymentSheet).mockResolvedValue({ kind: "failed", reason: "failed" });

    await act(async () => fireEvent.press(chip("10% · $9.99")));
    await act(async () => fireEvent.press(payButton())); // no answer
    await act(async () => fireEvent.press(payButton())); // its retry: answered, the card refused
    await act(async () => fireEvent.press(payButton())); // Try again: a new attempt
    await act(async () => fireEvent.press(chip("5% · $9.01")));
    await act(async () => fireEvent.press(payButton())); // another choice

    const [first, retry, again, other] = sentKeys();
    expect(first).toMatch(UUID);
    expect(retry).toBe(first);
    expect(again).toMatch(UUID);
    expect(again).not.toBe(first);
    expect(other).toMatch(UUID);
    expect(new Set([first, again, other]).size).toBe(3);
  });

  it("too many tries says wait, keeps the choice, and the retry carries the same key", async () => {
    await renderCard();
    jest.mocked(apiPost).mockRejectedValue(new ApiError(429, "rate_limited"));

    await act(async () => fireEvent.press(chip("10% · $9.99")));
    await act(async () => fireEvent.press(payButton()));

    expect(screen.getByTestId("tip-failed")).toHaveTextContent(
      "Too many tries in a short time. Wait a moment, then try again. Your job is still confirmed.",
    );
    expect(payButton().props.accessibilityState).toMatchObject({ disabled: false });
    await act(async () => fireEvent.press(payButton()));
    const [first, retry] = sentKeys();
    expect(retry).toBe(first);
  });

  it("a tip support must look at first says so and offers no choice", async () => {
    await renderCard();
    jest.mocked(apiPost).mockRejectedValue(new ApiError(409, "tip_needs_review"));

    await act(async () => fireEvent.press(chip("10% · $9.99")));
    await act(async () => fireEvent.press(payButton()));

    expect(screen.getByTestId("tip-failed")).toHaveTextContent(
      "Our support team is checking this tip. Your job is still confirmed; you don't need to do anything.",
    );
    expect(screen.getByTestId("tip-failed").props.className).toContain("bg-navy-900/5");
    expect(screen.queryByTestId("tip-options")).toBeNull();
    expect(screen.queryByTestId("tip-pay")).toBeNull();
    expect(screen.queryByRole("button", { name: "No tip" })).toBeNull();
    expect(tipCalls()).toHaveLength(1);
  });

  it("a tip already under way asks for the job again and says it shows soon", async () => {
    await renderCard();
    jest.mocked(apiPost).mockRejectedValue(new ApiError(409, "tip_in_progress"));
    const reads = () => jest.mocked(apiGet).mock.calls.length;
    const before = reads();

    await act(async () => fireEvent.press(chip("10% · $9.99")));
    await act(async () => fireEvent.press(payButton()));

    await waitFor(() => expect(reads()).toBeGreaterThan(before));
    expect(screen.getByTestId("tip-failed")).toHaveTextContent(
      "This tip is already being processed. It shows here soon.",
    );
    // Under way is news, not an error: the info tint, not the danger one.
    expect(screen.getByTestId("tip-failed").props.className).toContain("bg-navy-900/5");
  });

  it("a key the server says was used for another choice is dropped: the next try has a new one", async () => {
    await renderCard();
    jest.mocked(apiPost).mockRejectedValue(new ApiError(409, "idempotency_key_reused"));

    await act(async () => fireEvent.press(chip("10% · $9.99")));
    await act(async () => fireEvent.press(payButton()));
    expect(screen.getByTestId("tip-failed")).toHaveTextContent(
      "Something went wrong with the tip. Your job is still confirmed.",
    );
    await act(async () => fireEvent.press(payButton()));

    const [first, next] = sentKeys();
    expect(next).toMatch(UUID);
    expect(next).not.toBe(first);
  });

  it("a tip paid before shows as a record, not a question", async () => {
    await renderCard(tipOut({ status: "succeeded", amount_cents: 2500, can_tip: false }));
    expect(screen.getByTestId("tip-done")).toHaveTextContent("You tipped Dan $25.00. Thank you!");
    expect(screen.queryByTestId("tip-options")).toBeNull();
    // Only a tip paid from this card is felt; opening one paid before is not.
    await flush();
    expect(Haptics.notificationAsync).not.toHaveBeenCalled();
  });

  it("a preset the server no longer offers (422) says so and asks for the job again", async () => {
    await renderCard();
    jest.mocked(apiPost).mockRejectedValue(new ApiError(422, "tip_percent_not_offered"));
    const reads = () => jest.mocked(apiGet).mock.calls.length;
    const before = reads();

    await act(async () => fireEvent.press(chip("10% · $9.99")));
    await act(async () => fireEvent.press(payButton()));
    await flush();

    expect(screen.getByTestId("tip-failed")).toHaveTextContent(
      "Something went wrong with the tip. Your job is still confirmed.",
    );
    // The presets changed meanwhile: the job's answer brings the ones offered now.
    expect(reads()).toBeGreaterThan(before);
  });

  it.each([
    ["1", 100],
    ["180", 18_000],
  ])("a custom amount on the server's bound ($%s) is sent", async (typed, cents) => {
    await renderCard();
    jest.mocked(apiPost).mockResolvedValue({
      tip: tipOut({ status: "requires_payment" }),
      sheet: SHEET,
    } as never);
    jest.mocked(openPaymentSheet).mockResolvedValue({ kind: "canceled" });

    await act(async () => fireEvent.press(chip("Custom")));
    await act(async () => fireEvent.changeText(screen.getByTestId("tip-custom-amount"), typed));
    await act(async () => fireEvent.press(payButton()));

    expect(tipCalls()[0]?.[1]).toEqual({ choice: "custom", amount_cents: cents });
  });

  it("a press while a tip is under way is ignored: one request, one sheet, every choice disabled", async () => {
    await renderCard();
    let answerTip: (value: unknown) => void = () => undefined;
    jest.mocked(apiPost).mockImplementation(
      (() =>
        new Promise((resolve) => {
          answerTip = resolve;
        })) as unknown as typeof apiPost,
    );
    jest.mocked(openPaymentSheet).mockResolvedValue({ kind: "canceled" });
    const noTip = () => screen.getByRole("button", { name: "No tip" });

    await act(async () => fireEvent.press(chip("10% · $9.99")));
    await act(async () => fireEvent.press(payButton()));

    try {
      // The API has not answered yet: Tip says it is busy, and no other choice can be made.
      expect(payButton().props.accessibilityState).toMatchObject({ disabled: true, busy: true });
      expect(noTip().props.accessibilityState).toMatchObject({ disabled: true });
      for (const name of ["5% · $9.01", "10% · $9.99", "15% · $27.01", "Custom"]) {
        expect(chip(name).props.accessibilityState).toMatchObject({ disabled: true });
      }
      await act(async () => fireEvent.press(payButton()));
      await act(async () => fireEvent.press(noTip()));
      await act(async () => fireEvent.press(chip("5% · $9.01")));
      expect(tipCalls()).toHaveLength(1);
    } finally {
      // Answered even when an expectation above fails, so the app-wide sheet lock is free again.
      await act(async () =>
        answerTip({ tip: tipOut({ status: "requires_payment" }), sheet: SHEET }),
      );
      await tick();
    }
    expect(tipCalls()).toEqual([[TIP_PATH, { choice: "percent", percent: 10 }, expect.anything()]]);
    expect(openPaymentSheet).toHaveBeenCalledTimes(1);
    // The sheet closed: the first choice is still the one picked, and every choice is open again.
    expect(chip("10% · $9.99").props.accessibilityState).toMatchObject({
      checked: true,
      disabled: false,
    });
    expect(payButton().props.accessibilityState).toMatchObject({ disabled: false });
    expect(noTip().props.accessibilityState).toMatchObject({ disabled: false });
  });

  it("two taps before the card redraws send once: the first takes the one sheet", async () => {
    jest.mocked(apiPost).mockResolvedValue({
      tip: tipOut({ status: "requires_payment" }),
      sheet: SHEET,
    } as never);
    jest.mocked(openPaymentSheet).mockResolvedValue({ kind: "canceled" });
    const job = withTip(tipOut());
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = await renderHook(() => useTip(REQUEST_ID, job), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });

    await act(async () => result.current.select({ kind: "percent", percent: 10 }));
    // Both taps reach the card as drawn (enabled, idle) before the busy card is drawn: the sheet
    // lock is what ignores the second.
    const drawn = result.current;
    await act(async () => {
      drawn.pay();
      drawn.pay();
    });
    await tick();

    expect(tipCalls()).toHaveLength(1);
    expect(openPaymentSheet).toHaveBeenCalledTimes(1);
  });

  it("paid in the sheet and still no answer when the wait ends: it says the tip shows soon, no second tip", async () => {
    await renderCard();
    jest.mocked(apiPost).mockImplementation((async () => {
      answer("requires_payment", { choice: "percent", percent: 10, amount_cents: 999 });
      return { tip: tipOut({ status: "requires_payment", amount_cents: 999 }), sheet: SHEET };
    }) as unknown as typeof apiPost);
    jest.mocked(openPaymentSheet).mockResolvedValue({ kind: "paid" });

    await act(async () => fireEvent.press(chip("10% · $9.99")));
    await act(async () => fireEvent.press(payButton()));
    await act(async () => {
      await jest.advanceTimersByTimeAsync(paymentConfig.pollTimeoutMs - 1);
    });
    expect(screen.queryByTestId("tip-delayed")).toBeNull();
    expect(payButton().props.accessibilityState).toMatchObject({ busy: true });

    await act(async () => {
      await jest.advanceTimersByTimeAsync(paymentConfig.pollIntervalMs);
    });
    await tick();
    expect(screen.getByTestId("tip-delayed")).toHaveTextContent(
      "We're still confirming your tip. It shows here soon.",
    );
    expect(screen.queryByTestId("tip-failed")).toBeNull();
    expect(screen.queryByTestId("tip-done")).toBeNull();
    // The payment may still land: the card offers no second one meanwhile.
    expect(payButton().props.accessibilityState).toMatchObject({ disabled: true });
    expect(screen.getByRole("button", { name: "No tip" }).props.accessibilityState).toMatchObject({
      disabled: true,
    });
    expect(tipCalls()).toHaveLength(1);
  });

  it("a custom amount the server refuses (422) says so on the field, not as a failure", async () => {
    await renderCard();
    jest.mocked(apiPost).mockRejectedValue(new ApiError(422, "tip_amount_out_of_range"));

    await act(async () => fireEvent.press(chip("Custom")));
    await act(async () => fireEvent.changeText(screen.getByTestId("tip-custom-amount"), "12.5"));
    await act(async () => fireEvent.press(payButton()));

    // Within the bounds the card knew, so it was sent; the server's answer is the field's error.
    expect(tipCalls()).toHaveLength(1);
    expect(screen.getByText("Enter an amount from $1.00 to $180.00.")).toBeTruthy();
    expect(screen.queryByTestId("tip-failed")).toBeNull();
    expect(screen.getByTestId("tip-custom-amount").props.value).toBe("12.5");
    expect(payButton().props.accessibilityState).toMatchObject({ disabled: false });
  });

  it.each([500, 503])(
    "a %i says something went wrong and the retry carries the same key",
    async (status) => {
      await renderCard();
      jest.mocked(apiPost).mockRejectedValue(new ApiError(status, "server_error"));

      await act(async () => fireEvent.press(chip("10% · $9.99")));
      await act(async () => fireEvent.press(payButton()));
      expect(screen.getByTestId("tip-failed")).toHaveTextContent(
        "Something went wrong with the tip. Your job is still confirmed.",
      );
      await act(async () => fireEvent.press(payButton()));

      const [first, retry] = sentKeys();
      expect(first).toMatch(UUID);
      expect(retry).toBe(first);
    },
  );
});
