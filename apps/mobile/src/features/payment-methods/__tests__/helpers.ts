import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react-native";
import { createElement, type ReactElement, type ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { toastStore } from "@/components/ui/toast";

import { METRICS } from "../../auth/__tests__/helpers";
import { PAYMENT_METHODS_QUERY_KEY } from "../api";
import type { SavedCard, Wallet } from "../cards";

export const WALLET_PATH = "/v1/me/payment-methods";
export const SETUP_PATH = "/v1/me/payment-methods/setup-intent";
export const DEFAULT_PATH = "/v1/me/payment-methods/{payment_method_id}/default";
export const CARD_PATH = "/v1/me/payment-methods/{payment_method_id}";

export const card = (overrides: Partial<SavedCard> & Pick<SavedCard, "id">): SavedCard => ({
  brand: "visa",
  last4: "4242",
  exp_month: 12,
  exp_year: 2028,
  is_default: false,
  ...overrides,
});

export const VISA = card({ id: "pm_visa", is_default: true });
export const MASTER = card({
  id: "pm_master",
  brand: "mastercard",
  last4: "4444",
  exp_month: 3,
  exp_year: 2030,
});
export const AMEX = card({
  id: "pm_amex",
  brand: "amex",
  last4: "0005",
  exp_month: 7,
  exp_year: 2027,
});
export const DISCOVER = card({ id: "pm_discover", brand: "discover", last4: "1117" });
/** A brand the wallet has no mark of its own for. */
export const JCB = card({ id: "pm_jcb", brand: "jcb", last4: "0505" });
/** The card an add saves: Stripe attaches it, and no card is the default by that alone. */
export const NEW = card({ id: "pm_new", last4: "5556", exp_month: 1, exp_year: 2031 });

// Recognizable values: no log line, cache entry, toast or screen may ever carry one of them.
export const SETUP = {
  client_secret: "seti_123_secret_456",
  ephemeral_key_secret: "ek_test_789",
  customer_id: "cus_jack",
  publishable_key: "pk_test_jack",
};
export const SECRETS = Object.values(SETUP);

/** A cache per test that sets no timers: a finished mutation is otherwise kept for minutes. */
export const newQueryClient = () =>
  new QueryClient({
    defaultOptions: { queries: { gcTime: Infinity }, mutations: { gcTime: Infinity } },
  });

/** A cache that already holds the wallet, as when a card opens from the wallet's screen. */
export function walletClient(cards: Wallet): QueryClient {
  const client = newQueryClient();
  client.setQueryData(PAYMENT_METHODS_QUERY_KEY, cards);
  return client;
}

/** Renders a screen under the safe area (the test file mocks the module) and a Query cache. */
export const renderWallet = (ui: ReactElement, client: QueryClient = newQueryClient()) =>
  render(ui, {
    wrapper: ({ children }: { children: ReactNode }) =>
      createElement(
        SafeAreaProvider,
        { initialMetrics: METRICS },
        createElement(QueryClientProvider, { client }, children),
      ),
  });

/** The cached wallet in its order, the default starred. */
export const cachedWallet = (client: QueryClient) =>
  client
    .getQueryData<Wallet>(PAYMENT_METHODS_QUERY_KEY)
    ?.map((saved) => (saved.is_default ? `${saved.id}*` : saved.id));

/** The toast on screen, if any. */
export const toast = () => {
  const current = toastStore.getState().current;
  return current && { message: current.message, tone: current.tone };
};
