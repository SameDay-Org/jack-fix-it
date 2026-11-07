import type { ApiSchema } from "@jack/shared";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

import { onSignOut } from "@/api";

export type PaymentSheetOut = ApiSchema<"PaymentSheetOut">;

/** What the customer is about to pay, as the API priced it: never the sheet's secrets. */
export type PaymentSummary = Pick<
  PaymentSheetOut,
  "amount_cents" | "tax_cents" | "customer_total_cents" | "currency"
>;

/** A payment the sheet reported as done, while the job it creates is not visible yet. */
export type Confirming = {
  /** When the sheet reported it (ms since the epoch): the confirmation waits from here. */
  since: number;
  /** The session the payment ran in: the confirmation's calls belong to it alone. */
  generation: number;
};

type PaymentState = {
  /** A quote accepted a moment ago: its card opens the sheet once the request screen is back. */
  autoPay: { quoteId: string; generation: number } | null;
  /** Per quote: the last price the API sent for the sheet. */
  summaries: Readonly<Record<string, PaymentSummary>>;
  /** Per quote: paid in the sheet, waiting for the job. */
  confirming: Readonly<Record<string, Confirming>>;
};

const EMPTY: PaymentState = { autoPay: null, summaries: {}, confirming: {} };

/**
 * Payment progress kept outside any screen: the accept sheet hands its quote to the card, and a
 * card that remounts (back from a profile) still knows a payment is being confirmed. Nothing in
 * it is secret. It belongs to the session: a sign-out or another account forgets all of it.
 */
export const paymentStore = createStore<PaymentState>()(() => EMPTY);

onSignOut(() => {
  paymentStore.setState(EMPTY, true);
});

export function requestAutoPay(quoteId: string, generation: number): void {
  paymentStore.setState({ autoPay: { quoteId, generation } });
}

/** The pending auto-pay for this quote, taken once: a later focus does not open the sheet again. */
export function takeAutoPay(quoteId: string): { generation: number } | null {
  const { autoPay } = paymentStore.getState();
  if (autoPay?.quoteId !== quoteId) return null;
  paymentStore.setState({ autoPay: null });
  return { generation: autoPay.generation };
}

export function rememberSummary(quoteId: string, sheet: PaymentSheetOut): void {
  const summary: PaymentSummary = {
    amount_cents: sheet.amount_cents,
    tax_cents: sheet.tax_cents,
    customer_total_cents: sheet.customer_total_cents,
    currency: sheet.currency,
  };
  paymentStore.setState((state) => ({ summaries: { ...state.summaries, [quoteId]: summary } }));
}

export function startConfirming(quoteId: string, confirming: Confirming): void {
  paymentStore.setState((state) => ({
    confirming: { ...state.confirming, [quoteId]: confirming },
  }));
}

export function stopConfirming(quoteId: string): void {
  paymentStore.setState((state) => {
    if (!(quoteId in state.confirming)) return state;
    const rest = { ...state.confirming };
    delete rest[quoteId];
    return { confirming: rest };
  });
}

export const useAutoPayPending = (quoteId: string): boolean =>
  useStore(paymentStore, (state) => state.autoPay?.quoteId === quoteId);

export const usePaymentSummary = (quoteId: string): PaymentSummary | undefined =>
  useStore(paymentStore, (state) => state.summaries[quoteId]);

export const useConfirming = (quoteId: string): Confirming | undefined =>
  useStore(paymentStore, (state) => state.confirming[quoteId]);
