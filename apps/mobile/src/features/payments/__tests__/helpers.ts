import type { QueryClient } from "@tanstack/react-query";
import { act, screen, within } from "@testing-library/react-native";
import { createElement, Fragment } from "react";

import { apiGet, apiPost, ApiError } from "@/api";
import { AcceptQuoteSheet } from "@/features/quotes/AcceptQuoteSheet";
import { QuoteCompareScreen } from "@/features/quotes/QuoteCompareScreen";
import type { CustomerQuote, CustomerQuoteList } from "@/features/quotes/useRequestQuotes";

import { navigation, NOW, quote } from "../../quotes/__tests__/helpers";
import { paymentStore, type PaymentSheetOut } from "../paymentStore";
import type { CustomerJob } from "../useRequestJob";

export const JOB_PATH = "/v1/requests/{request_id}/job";
export const PAYMENT_PATH = "/v1/requests/{request_id}/quotes/{quote_id}/payment";
export const ACCEPT_PATH = "/v1/requests/{request_id}/quotes/{quote_id}/accept";

/** A quote whose pro the API names, priced in cents that show both digits. */
export const QUOTE = quote(1, { amount_cents: 18_050, pro: { name: "María P." } });
export const ACCEPTED: CustomerQuote = { ...QUOTE, status: "accepted" };
export const OTHER = quote(2, { amount_cents: 25_000, pro: { name: "Dan K." } });

// Recognizable values: no log line, toast or screen may ever carry one of them.
export const SECRETS = ["pi_123_secret_456", "ek_test_789", "pk_test_jack", "cus_jack"];

export const SHEET: PaymentSheetOut = {
  payment_intent_client_secret: "pi_123_secret_456",
  customer_id: "cus_jack",
  ephemeral_key_secret: "ek_test_789",
  publishable_key: "pk_test_jack",
  amount_cents: 18_050,
  tax_cents: 0,
  customer_total_cents: 18_050,
  currency: "usd",
};

export const JOB: CustomerJob = {
  id: "00000000-0000-4000-8000-000000000301",
  status: "scheduled",
  customer_status: "customerStatus.scheduled",
  scheduled_start_at: new Date(NOW + 48 * 3_600_000).toISOString(),
  pro: ACCEPTED.pro,
  eta_at: null,
  arrival_code: null,
  confirm_by: null,
  timeline: [{ type: "created", status: "scheduled", at: new Date(NOW).toISOString() }],
  // The pro's photos (#298): none on a job that has not started.
  photos: { before: [], after: [], pending: 0 },
  // Chat messages not read yet (#71): none; the screen does not show them yet.
  unread_messages: 0,
  amount_cents: 18_050,
  tax_cents: 0,
  customer_total_cents: 18_050,
};

export const notFound = () => new ApiError(404, "not_found");
export const list = (items: CustomerQuote[]): CustomerQuoteList => ({ items });

type Answer<T> = () => Promise<T>;

/** What the mocked API answers, per path; a test swaps one answer at a time. */
export const api = {
  quotes: (() => Promise.resolve(list([ACCEPTED, OTHER]))) as Answer<CustomerQuoteList>,
  job: (() => Promise.reject(notFound())) as Answer<CustomerJob>,
  accept: (() => Promise.resolve(ACCEPTED)) as Answer<CustomerQuote>,
  payment: (() => Promise.resolve(SHEET)) as Answer<PaymentSheetOut>,
};

/** Routes the mocked `apiGet` and `apiPost` to `api`'s answers by path. */
export function routeApi(): void {
  jest
    .mocked(apiGet)
    .mockReset()
    .mockImplementation(((path: string) =>
      path === JOB_PATH ? api.job() : api.quotes()) as unknown as typeof apiGet);
  jest
    .mocked(apiPost)
    .mockReset()
    .mockImplementation(((path: string) =>
      path === PAYMENT_PATH ? api.payment() : api.accept()) as unknown as typeof apiPost);
}

export const callsTo = (mock: jest.Mock | typeof apiGet | typeof apiPost, path: string) =>
  jest.mocked(mock).mock.calls.filter(([called]) => called === path);

export function resetPayments(): void {
  paymentStore.setState({ autoPay: null, summaries: {}, confirming: {} }, true);
}

/** The session double inside the `@/api` mock (see the suite's `jest.mock`). */
export type SessionDouble = { generation: number; forget: Set<() => void> };

/** A sign-out as `src/api` runs it: a new generation, the cache cleared, session data forgotten. */
export async function signOut(session: SessionDouble, client: QueryClient): Promise<void> {
  await act(async () => {
    session.generation += 1;
    client.clear();
    session.forget.forEach((forget) => forget());
  });
}

/** The quote screen with the accept sheet over it while the (mocked) router has it open. */
export function App() {
  const sheet = navigation.useSheet();
  return createElement(
    Fragment,
    null,
    createElement(QuoteCompareScreen),
    sheet ? createElement(AcceptQuoteSheet) : null,
  );
}

export const card = (item: CustomerQuote) => within(screen.getByTestId(`quote-${item.id}`));
export const payTestId = (item: CustomerQuote) => `quote-${item.id}-payment`;
