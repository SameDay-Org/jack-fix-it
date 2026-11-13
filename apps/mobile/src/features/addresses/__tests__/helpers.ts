import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react-native";
import { createElement, type ReactElement, type ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { savedAddress } from "../../request/__tests__/helpers";
import { METRICS } from "../../auth/__tests__/helpers";
import { SAVED_ADDRESSES_QUERY_KEY, type SavedAddress } from "../api";

export { savedAddress };

// As the API lists them: the default first, then the oldest first.
export const HOME = savedAddress({ id: "home", label: "Home", is_default: true });
export const WORK = savedAddress({
  id: "work",
  label: "Work",
  line1: "500 Market St",
  line2: "Suite 12",
  is_default: false,
});
export const CABIN = savedAddress({
  id: "cabin",
  label: "Cabin",
  zip_code: "99950",
  is_default: false,
  served: false,
});

/** A cache per test that sets no timers: a finished mutation is otherwise kept for minutes. */
export const newQueryClient = () =>
  new QueryClient({
    defaultOptions: { queries: { gcTime: Infinity }, mutations: { gcTime: Infinity } },
  });

/** A cache that already holds the book, as when the screen opens from the list. */
export function bookClient(items: SavedAddress[]): QueryClient {
  const client = newQueryClient();
  client.setQueryData(SAVED_ADDRESSES_QUERY_KEY, { items });
  return client;
}

/** Renders a screen under the safe area (the test file mocks the module) and a Query cache. */
export const renderAddresses = (ui: ReactElement, client: QueryClient = newQueryClient()) =>
  render(ui, {
    wrapper: ({ children }: { children: ReactNode }) =>
      createElement(
        SafeAreaProvider,
        { initialMetrics: METRICS },
        createElement(QueryClientProvider, { client }, children),
      ),
  });

/** The cached book, its default starred. */
export const cachedBook = (client: QueryClient) =>
  client
    .getQueryData<{ items: SavedAddress[] }>(SAVED_ADDRESSES_QUERY_KEY)
    ?.items.map((address) => (address.is_default ? `${address.id}*` : address.id));
