import { useEffect, useSyncExternalStore } from "react";

import type { OpportunityPage, OpportunitySummary } from "../../pro-home/useOpportunities";
import type { OpportunityDetail, OpportunityMedia } from "../useOpportunity";

export {
  fakeClock,
  freezeClock,
  newQueryClient,
  renderWithQuery,
} from "../../quotes/__tests__/helpers";

export const DISPATCH_ID = "6f1c2a40-0000-4000-8000-000000000219";
/** 2026-10-28 14:00 UTC: every fixture time is relative to it. */
export const NOW = Date.parse("2026-10-28T14:00:00Z");
const MINUTE_MS = 60_000;
export const minutesFromNow = (minutes: number) =>
  new Date(NOW + minutes * MINUTE_MS).toISOString();
export const hoursFromNow = (hours: number) => minutesFromNow(hours * 60);

export const PAINTING = {
  id: "00000000-0000-4000-8000-000000000003",
  slug: "painting",
  names: { en: "Painting", es: "Pintura" },
};

const EXCERPT =
  "The hallway and two bedrooms need a fresh coat; the ceiling in one bedroom has a water stain " +
  "that should be primed first. Paint is already";

/** One row of the list, sent two hours ago, not opened yet, with a preferred date. */
export const summary = (
  n: number,
  overrides: Partial<OpportunitySummary> = {},
): OpportunitySummary => ({
  dispatch_id: `00000000-0000-4000-8000-0000000003${String(n).padStart(2, "0")}`,
  public_code: `JF-0001${String(n).padStart(2, "0")}`,
  category: PAINTING,
  description_excerpt: EXCERPT,
  location: { zip_code: "33301", city: "Fort Lauderdale" },
  preferred_date: "2026-10-30",
  preferred_period: null,
  sent_at: hoursFromNow(-2),
  viewed: false,
  text_redacted: false,
  ...overrides,
});

export const page = (
  items: OpportunitySummary[],
  next_cursor: string | null = null,
): OpportunityPage => ({
  items,
  next_cursor,
});

/** A photo whose signed URL is good for five more minutes. */
export const mediaItem = (
  n: number,
  overrides: Partial<OpportunityMedia> = {},
): OpportunityMedia => ({
  kind: "photo",
  content_type: "image/jpeg",
  url: `https://media.test.invalid/m/${n}.jpg?sig=${n}`,
  expires_at: minutesFromNow(5),
  ...overrides,
});

export const VIDEO = mediaItem(3, {
  kind: "video",
  content_type: "video/mp4",
  url: "https://media.test.invalid/m/3.mp4?sig=3",
});

/** The opened opportunity: two photos and a video ready, two more being prepared. */
export const detail = (overrides: Partial<OpportunityDetail> = {}): OpportunityDetail => ({
  dispatch_id: DISPATCH_ID,
  public_code: "JF-000124",
  category: PAINTING,
  description: `${EXCERPT} bought: two cans of eggshell white. Weekday mornings work best.`,
  intake_answers: {},
  location: { zip_code: "33301", city: "Fort Lauderdale" },
  preferred_date: "2026-10-30",
  preferred_period: null,
  sent_at: hoursFromNow(-2),
  viewed_at: null,
  text_redacted: false,
  media: [mediaItem(1), mediaItem(2), VIDEO],
  media_pending: 2,
  take_rate_bps: 1500,
  quote_max_amount_cents: null,
  quote_max_duration_minutes: null,
  ...overrides,
});

/**
 * A stand-in for the router. The screen reads `useLocalSearchParams` from `params`, is focused
 * unless a test blurs it, and reads as idle (`unstable_useIsNavigating` false) unless a test says
 * a transition is under way. `router` calls are plain mocks. Use it as the `expo-router` mock:
 * `jest.mock("expo-router", () => jest.requireActual("./helpers").routerMock)`.
 */
const nav = {
  params: { id: DISPATCH_ID } as Record<string, string>,
  focused: true,
  navigating: false,
  canGoBack: true,
  listeners: new Set<() => void>(),
};

type NavState = Pick<typeof nav, "params" | "focused" | "navigating" | "canGoBack">;

function update(change: Partial<NavState>): void {
  Object.assign(nav, change);
  nav.listeners.forEach((listener) => listener());
}

const subscribe = (listener: () => void) => {
  nav.listeners.add(listener);
  return () => nav.listeners.delete(listener);
};

/** The screen's leave guard (`usePreventRemove`), as last rendered. */
type RemoveEvent = { data: { action: { type: string } }; repeat: () => void };
const guard = {
  prevent: false,
  callback: null as ((event: RemoveEvent) => void) | null,
};

/** The action a back gesture or a back button dispatches. */
export const GO_BACK = { type: "GO_BACK" };

export const navigation = {
  setParams: (params: Record<string, string>) => update({ params }),
  setFocused: (focused: boolean) => update({ focused }),
  setNavigating: (navigating: boolean) => update({ navigating }),
  setCanGoBack: (canGoBack: boolean) => update({ canGoBack }),
  reset: () =>
    update({ params: { id: DISPATCH_ID }, focused: true, navigating: false, canGoBack: true }),
  /**
   * A back gesture or the system back on the screen: true when nothing guards it (the screen
   * would leave); otherwise the guard's callback runs, as expo-router calls it. Like expo-router,
   * the guard blocks any removal while it is on; its `repeat` turns it off and replays the action
   * (`navigation.repeated`).
   */
  attemptLeave: (): boolean => {
    if (!guard.prevent) return true;
    guard.callback?.({
      data: { action: GO_BACK },
      repeat: () => {
        guard.prevent = false;
        navigation.repeated(GO_BACK);
      },
    });
    return false;
  },
  /** The blocked actions a guard's `repeat` replayed. */
  repeated: jest.fn(),
};

const useIsNavigating = () => useSyncExternalStore(subscribe, () => nav.navigating);

export const routerMock = {
  router: {
    push: jest.fn(),
    back: jest.fn(),
    replace: jest.fn(),
    dismissTo: jest.fn(),
    canGoBack: jest.fn(() => nav.canGoBack),
  },
  useLocalSearchParams: () => useSyncExternalStore(subscribe, () => nav.params),
  unstable_useIsNavigating: useIsNavigating,
  useIsFocused: () => useSyncExternalStore(subscribe, () => nav.focused),
  usePreventRemove: (prevent: boolean, callback: (event: RemoveEvent) => void) => {
    useEffect(() => {
      guard.prevent = prevent;
      guard.callback = callback;
    });
    useEffect(
      () => () => {
        guard.prevent = false;
        guard.callback = null;
      },
      [],
    );
  },
  // Runs the effect on every focus and cleans it up on blur, as React Navigation does.
  useFocusEffect: (effect: () => void | (() => void)) => {
    const focused = useSyncExternalStore(subscribe, () => nav.focused);
    useEffect(() => (focused ? effect() : undefined), [effect, focused]);
  },
};
