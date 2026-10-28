import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react-native";
import {
  createElement,
  useEffect,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import type { CustomerQuote } from "../useRequestQuotes";

import { METRICS } from "../../auth/__tests__/helpers";

export const REQUEST_ID = "6f1c2a40-0000-4000-8000-000000000190";
/** 2026-10-28 14:00 UTC: every fixture time is relative to it. */
export const NOW = Date.parse("2026-10-28T14:00:00Z");
const HOUR_MS = 3_600_000;
const at = (hours: number) => new Date(NOW + hours * HOUR_MS).toISOString();

type QuoteOverrides = Partial<Omit<CustomerQuote, "pro">> & { pro?: Partial<CustomerQuote["pro"]> };

export const quote = (n: number, overrides: QuoteOverrides = {}): CustomerQuote => ({
  id: `00000000-0000-4000-8000-00000000010${n}`,
  amount_cents: 18_000,
  scope: "Replace the kitchen faucet and check the supply lines.",
  duration_minutes: 120,
  proposed_start_at: at(48),
  expires_at: at(6),
  status: "pending",
  created_at: at(-2),
  ...overrides,
  pro: {
    id: `00000000-0000-4000-8000-00000000020${n}`,
    name: `Pro ${n}.`,
    rating_avg: "4.80",
    jobs_count: 12,
    years_of_experience: 8,
    verified: true,
    ...overrides.pro,
  },
});

/**
 * Three quotes in the order the mocked API sends them. No field runs in order, up or down (id,
 * price, created_at, expires_at, proposed_start_at), so any client-side sort would show: a pro
 * whose name the API withholds, María P. (verified, no rating yet), and Dan K. (not verified, one
 * job, no years given).
 */
export const QUOTES: CustomerQuote[] = [
  quote(1, {
    amount_cents: 18_050,
    duration_minutes: 45,
    created_at: at(-2),
    expires_at: at(6),
    proposed_start_at: at(48),
    pro: { name: null, rating_avg: "4.25", jobs_count: 3, years_of_experience: 1 },
  }),
  quote(3, {
    amount_cents: 25_000,
    duration_minutes: 90,
    created_at: at(-1),
    expires_at: at(2),
    proposed_start_at: at(72),
    pro: { name: "María P.", rating_avg: null, jobs_count: 12, years_of_experience: 8 },
  }),
  quote(2, {
    amount_cents: 12_000,
    duration_minutes: 180,
    created_at: at(-3),
    expires_at: at(30),
    proposed_start_at: at(24),
    pro: {
      name: "Dan K.",
      rating_avg: "4.80",
      jobs_count: 1,
      years_of_experience: null,
      verified: false,
    },
  }),
];

// What the screen needs from the real event loop: React's and the testing library's scheduling.
const LOOP = ["nextTick", "queueMicrotask", "setImmediate", "clearImmediate"] as const;
const FRAMES = [
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "requestIdleCallback",
  "cancelIdleCallback",
  "performance",
  "hrtime",
] as const;

/** Date.now() is NOW and stays there; timers stay real. */
export const freezeClock = () =>
  jest.useFakeTimers({
    now: NOW,
    doNotFake: [...LOOP, ...FRAMES, "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });

/** Date.now() starts at NOW and timers are fake: `jest.advanceTimersByTime` moves both. */
export const fakeClock = () => jest.useFakeTimers({ now: NOW, doNotFake: [...LOOP, ...FRAMES] });

/**
 * A fresh cache per test. Kept queries and mutations never expire, so no garbage-collection timer
 * outlives the test (a finished mutation's default is a 5-minute timer, which kept Jest running).
 */
export const newQueryClient = () =>
  new QueryClient({
    defaultOptions: { queries: { gcTime: Infinity }, mutations: { gcTime: Infinity } },
  });

/** Renders under the safe area (the test file mocks the module) and a Query cache. */
export const renderWithQuery = (ui: ReactElement, client: QueryClient = newQueryClient()) =>
  render(ui, {
    wrapper: ({ children }: { children: ReactNode }) =>
      createElement(
        SafeAreaProvider,
        { initialMetrics: METRICS },
        createElement(QueryClientProvider, { client }, children),
      ),
  });

type SheetParams = { id: string; quote: string };
type PushedHref = { pathname: string; params: Record<string, string> };

/**
 * A stand-in for the router: `push` to the accept sheet opens it (the test's harness renders it;
 * a push anywhere else is only recorded), `back` closes it; the screen is focused unless a test
 * blurs it. The router reads as idle
 * (`unstable_useIsNavigating` false) unless a test says a transition is under way with
 * `navigation.setNavigating(true)` and lands it with `false`, as the real router does around a
 * push or a back. Use it as the `expo-router` mock:
 * `jest.mock("expo-router", () => jest.requireActual("./helpers").routerMock)`.
 */
const nav = {
  sheet: null as SheetParams | null,
  focused: true,
  navigating: false,
  listeners: new Set<() => void>(),
};

function update(change: Partial<Pick<typeof nav, "sheet" | "focused" | "navigating">>): void {
  Object.assign(nav, change);
  nav.listeners.forEach((listener) => listener());
}

const subscribe = (listener: () => void) => {
  nav.listeners.add(listener);
  return () => nav.listeners.delete(listener);
};

export const navigation = {
  useSheet: () => useSyncExternalStore(subscribe, () => nav.sheet),
  setFocused: (focused: boolean) => update({ focused }),
  setNavigating: (navigating: boolean) => update({ navigating }),
  reset: () => update({ sheet: null, focused: true, navigating: false }),
};

const useIsNavigating = () => useSyncExternalStore(subscribe, () => nav.navigating);

export const routerMock = {
  router: {
    push: jest.fn((href: PushedHref) => {
      if (href.pathname === "/requests/[id]/accept") {
        update({ sheet: href.params as SheetParams });
      }
    }),
    back: jest.fn(() => update({ sheet: null })),
    canGoBack: jest.fn(() => true),
    dismissTo: jest.fn(),
  },
  useLocalSearchParams: () => nav.sheet ?? { id: REQUEST_ID },
  unstable_useIsNavigating: useIsNavigating,
  // Runs the effect on every focus and cleans it up on blur, as React Navigation does.
  useFocusEffect: (effect: () => void | (() => void)) => {
    const focused = useSyncExternalStore(subscribe, () => nav.focused);
    useEffect(() => (focused ? effect() : undefined), [effect, focused]);
  },
};
