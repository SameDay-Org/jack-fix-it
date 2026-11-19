import "@/i18n";

import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react-native";
import * as Haptics from "expo-haptics";

import { ApiError, apiGet, apiPost, NetworkError } from "@/api";
import { customerJobQueryOptions } from "@/features/jobs/api";
import type { CustomerJob } from "@/features/jobs/phase";
import { openPaymentSheet } from "@/features/payments/paymentSheet";

import { confirmedJob } from "../../jobs/__tests__/helpers";
import type { TipOut, TipStatus } from "../api";
import { TipCard } from "../TipCard";

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
        { auth: true, generation: 1, params: { request_id: REQUEST_ID } },
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

  it("a tip paid before shows as a record, not a question", async () => {
    await renderCard(tipOut({ status: "succeeded", amount_cents: 2500, can_tip: false }));
    expect(screen.getByTestId("tip-done")).toHaveTextContent("You tipped Dan $25.00. Thank you!");
    expect(screen.queryByTestId("tip-options")).toBeNull();
  });
});
