import i18n from "@/i18n";

import type { QueryClient } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react-native";
import { router } from "expo-router";
import {
  AccessibilityInfo,
  AppState,
  RefreshControl,
  type AppStateStatus,
  type NativeEventSubscription,
  type RefreshControlProps,
} from "react-native";
import { useReducedMotion, withTiming } from "react-native-reanimated";

import { ApiError, apiGet, apiPost, NetworkError } from "@/api";
import { dismissToast } from "@/components/ui/toast";
import { tokens } from "@/theme";

import { deferred, settle } from "../../../api/__tests__/helpers";
import {
  fakeClock,
  freezeClock,
  navigation,
  newQueryClient,
  NOW,
  quote,
  renderWithQuery,
  REQUEST_ID,
} from "../../quotes/__tests__/helpers";
import type { CustomerQuoteList } from "../../quotes/useRequestQuotes";
import { confirmJob } from "../api";
import { jobsConfig } from "../config";
import { JobScreen } from "../JobScreen";
import { formatMoment, type CustomerJob, type JobStatus, type JobTimelineEntry } from "../phase";

import { afterPhoto } from "./helpers";

type MockStatus = "signedIn" | "signedOut";
/** The session the mocked `@/api` hooks read; a test signs out by changing it and notifying. */
const mockSession = {
  status: "signedIn" as MockStatus,
  generation: 1,
  listeners: new Set<() => void>(),
};
/** The screen's focus as `useIsFocused` reads it (the quotes router mock has no such hook). */
const mockFocus = { focused: true, listeners: new Set<() => void>() };

jest.mock("@/api", () => {
  const { useSyncExternalStore } = jest.requireActual<typeof import("react")>("react");
  const subscribe = (listener: () => void) => {
    mockSession.listeners.add(listener);
    return () => {
      mockSession.listeners.delete(listener);
    };
  };
  return {
    ...jest.requireActual("../../../api/errors"),
    apiGet: jest.fn(),
    apiPost: jest.fn(),
    isCurrentGeneration: (generation: number) => generation === mockSession.generation,
    useSession: () => ({
      status: useSyncExternalStore(subscribe, () => mockSession.status),
      user: null,
    }),
    useSessionGeneration: () => useSyncExternalStore(subscribe, () => mockSession.generation),
    sessionGeneration: () => mockSession.generation,
    onSignOut: jest.fn(() => () => undefined),
  };
});
jest.mock("expo-router", () => {
  const { useSyncExternalStore } = jest.requireActual<typeof import("react")>("react");
  const subscribe = (listener: () => void) => {
    mockFocus.listeners.add(listener);
    return () => {
      mockFocus.listeners.delete(listener);
    };
  };
  return {
    ...jest.requireActual("../../quotes/__tests__/helpers").routerMock,
    useIsFocused: () => useSyncExternalStore(subscribe, () => mockFocus.focused),
  };
});
jest.mock("react-native-reanimated", () => {
  const actual =
    jest.requireActual<typeof import("react-native-reanimated")>("react-native-reanimated");
  return {
    __esModule: true,
    ...actual,
    useReducedMotion: jest.fn(() => false),
    withTiming: jest.fn(actual.withTiming),
  };
});
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);

const JOB_PATH = "/v1/requests/{request_id}/job";
const QUOTES_PATH = "/v1/requests/{request_id}/quotes";
const MINUTE_MS = 60_000;
const HIDDEN = { includeHiddenElements: true };
const NBSP = " ";
const CODE = "0427";
const { stepSlideMs } = tokens.motion;

const at = (minutes: number) => new Date(NOW + minutes * MINUTE_MS).toISOString();
const entry = (
  type: string,
  minutes: number,
  status: JobStatus | null = null,
): JobTimelineEntry => ({
  type,
  status,
  at: at(minutes),
});

const CREATED = entry("created", -120, "scheduled");
const LEFT = entry("status_changed", -40, "on_the_way");
const ETA_MOVED = entry("eta_updated", -35);
const CHECKED_IN = entry("checked_in", -30);
const STARTED = entry("status_changed", -25, "in_progress");
const UNKNOWN = entry("photo_added", -20);
const FINISHED = entry("status_changed", -10, "completed");
const CONFIRMED_AT = entry("status_changed", -5, "confirmed");

const job = (overrides: Partial<CustomerJob> = {}): CustomerJob => ({
  id: "6f1c2a40-0000-4000-8000-000000000640",
  status: "scheduled",
  customer_status: "customerStatus.scheduled",
  scheduled_start_at: at(26 * 60),
  pro: {
    id: "00000000-0000-4000-8000-000000000202",
    name: "Dan K.",
    rating_avg: "4.80",
    jobs_count: 12,
    years_of_experience: 8,
    verified: true,
  },
  eta_at: null,
  arrival_code: null,
  confirm_by: null,
  timeline: [CREATED],
  amount_cents: 18_000,
  tax_cents: 1_485,
  customer_total_cents: 19_485,
  // The pro's photos (#298): none here; the screen does not show them yet.
  photos: { before: [], after: [], pending: 0 },
  // Chat messages not read yet (#71): none; the screen does not show them yet.
  unread_messages: 0,
  ...overrides,
});

const SCHEDULED = job();
const ON_THE_WAY = job({
  status: "on_the_way",
  eta_at: at(12),
  arrival_code: CODE,
  timeline: [CREATED, LEFT],
});
const ARRIVED = job({
  status: "on_the_way",
  eta_at: at(12),
  timeline: [CREATED, LEFT, CHECKED_IN],
});
const WORKING = job({
  status: "in_progress",
  eta_at: at(-32),
  timeline: [CREATED, LEFT, ETA_MOVED, CHECKED_IN, STARTED, UNKNOWN],
});
const COMPLETED = job({
  status: "completed",
  timeline: [CREATED, LEFT, CHECKED_IN, STARTED, FINISHED],
});
const CONFIRMED = job({
  status: "confirmed",
  timeline: [CREATED, LEFT, CHECKED_IN, STARTED, FINISHED, CONFIRMED_AT],
});
const DISPUTED = job({
  status: "disputed",
  timeline: [CREATED, LEFT, CHECKED_IN, STARTED, FINISHED, entry("status_changed", -5, "disputed")],
});
const CANCELLED = job({
  status: "cancelled",
  timeline: [CREATED, entry("status_changed", -60, "cancelled")],
});

const ACCEPTED = quote(2, { status: "accepted" });
const QUOTE_LIST: CustomerQuoteList = { items: [quote(1), ACCEPTED] };

// Expected local times, with the screen's own call (the device's time zone; a moment on
// another local day than NOW carries its weekday, whatever zone the run is in).
const clock = (iso: string) => formatMoment(Date.parse(iso), NOW, "en-US");
const dateTime = (iso: string) =>
  new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));

type Get = (path: string, options?: unknown) => Promise<unknown>;
const get = apiGet as unknown as jest.MockedFunction<Get>;
const api = {
  job: (): Promise<unknown> => Promise.resolve(ON_THE_WAY),
  quotes: (): Promise<unknown> => Promise.resolve(QUOTE_LIST),
};
const answerJob = (value: CustomerJob) => {
  api.job = () => Promise.resolve(value);
};
const failJob = (error: Error) => {
  api.job = () => Promise.reject(error);
};
const holdJob = () => {
  const held = deferred<CustomerJob>();
  api.job = () => held.promise;
  return held;
};
const post = apiPost as unknown as jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
/** What was said aloud, in order (queued announcements, `announce`). */
const announced = () =>
  jest.mocked(AccessibilityInfo.announceForAccessibilityWithOptions).mock.calls.map(([m]) => m);
const jobCalls = () => get.mock.calls.filter(([path]) => path === JOB_PATH).length;

/** AppState listeners currently subscribed: a removed one is never called again. */
const appStateListeners = new Set<(state: AppStateStatus) => void>();
const ORIGINAL_STATE = Object.getOwnPropertyDescriptor(AppState, "currentState");
const setCurrentState = (state: AppStateStatus) =>
  Object.defineProperty(AppState, "currentState", {
    value: state,
    configurable: true,
    writable: true,
  });
async function moveApp(state: AppStateStatus): Promise<void> {
  await act(async () => {
    setCurrentState(state);
    appStateListeners.forEach((listener) => listener(state));
  });
}

async function setFocused(focused: boolean): Promise<void> {
  await act(async () => {
    mockFocus.focused = focused;
    mockFocus.listeners.forEach((listener) => listener());
    navigation.setFocused(focused);
  });
}

async function signOut(): Promise<void> {
  await act(async () => {
    mockSession.status = "signedOut";
    mockSession.generation = 2;
    mockSession.listeners.forEach((listener) => listener());
  });
}

/** Pulls the screen down: RN's Jest mock of RefreshControl keeps its latest instance. */
function pullToRefresh(): void {
  const mock = RefreshControl as unknown as { latestRef: { props: RefreshControlProps } | null };
  mock.latestRef?.props.onRefresh?.();
}

const advance = (ms: number) => act(async () => jest.advanceTimersByTime(ms));
const headline = (name: string) => screen.findByRole("header", { name });
/** The job on screen with its pro row live: the accepted quote landed too, nothing in flight. */
async function loaded(name: string) {
  const header = await headline(name);
  await screen.findByRole("button", { name: /^Dan K\./ });
  return header;
}

beforeEach(() => {
  freezeClock();
  navigation.reset();
  mockFocus.focused = true;
  mockSession.status = "signedIn";
  mockSession.generation = 1;
  api.job = () => Promise.resolve(ON_THE_WAY);
  api.quotes = () => Promise.resolve(QUOTE_LIST);
  get.mockReset().mockImplementation((path) => {
    if (path === JOB_PATH) return api.job();
    if (path === QUOTES_PATH) return api.quotes();
    return Promise.reject(new Error(`unexpected GET ${path}`));
  });
  appStateListeners.clear();
  setCurrentState("active");
  jest
    .mocked(AppState.addEventListener)
    .mockReset()
    .mockImplementation((_type, listener): NativeEventSubscription => {
      appStateListeners.add(listener);
      return {
        remove: () => {
          appStateListeners.delete(listener);
        },
      };
    });
  jest.mocked(router.push).mockClear();
  jest.mocked(router.dismissTo).mockClear();
  jest.mocked(AccessibilityInfo.announceForAccessibilityWithOptions).mockClear();
  jest.mocked(useReducedMotion).mockReturnValue(false);
});

afterEach(async () => {
  dismissToast();
  jest.useRealTimers();
  if (ORIGINAL_STATE) Object.defineProperty(AppState, "currentState", ORIGINAL_STATE);
  await act(() => i18n.changeLanguage("en"));
});

describe("JobScreen", () => {
  it.each([
    [
      "scheduled",
      SCHEDULED,
      "Dan is booked",
      `Scheduled for ${dateTime(SCHEDULED.scheduled_start_at)}`,
      0,
      false,
    ],
    [
      "on_the_way",
      ON_THE_WAY,
      "Dan is on the way",
      `Arriving around ${clock(at(12))} · in${NBSP}12${NBSP}min`,
      1,
      true,
    ],
    ["arrived", ARRIVED, "Dan has arrived", `Checked in at ${clock(CHECKED_IN.at)}`, 2, false],
    ["in_progress", WORKING, "Dan is working", `Started at ${clock(STARTED.at)}`, 2, false],
    [
      "disputed",
      DISPUTED,
      "This job needs attention",
      "A problem was reported on this job.",
      null,
      false,
    ],
    [
      "cancelled",
      CANCELLED,
      "This job was cancelled",
      "Nothing more is needed from you.",
      null,
      false,
    ],
  ] as const)(
    "%s: headline, support line, milestones and the code only on the way",
    async (_name, item, title, support, reached, code) => {
      answerJob(item);
      await renderWithQuery(<JobScreen />);

      expect(await loaded(title)).toBeTruthy();
      expect(screen.getByTestId("job-support").props.children).toBe(support);
      const milestones = screen.queryByTestId("job-milestones");
      expect(milestones?.props.accessibilityValue?.now ?? null).toBe(reached);
      expect(screen.queryByTestId("arrival-code") !== null).toBe(code);
      expect(screen.queryByText("Your arrival code") !== null).toBe(code);
    },
  );

  it("asks for the job with the session's generation pinned", async () => {
    await renderWithQuery(<JobScreen />);
    await loaded("Dan is on the way");

    expect(get).toHaveBeenCalledWith(JOB_PATH, {
      auth: true,
      signal: expect.any(AbortSignal),
      generation: 1,
      params: { request_id: REQUEST_ID },
    });
    expect(screen.getByTestId("job-milestones").props.accessibilityValue).toEqual({
      min: 0,
      max: 3,
      now: 1,
      text: "Step 1 of 3, On the way",
    });
  });

  it("on the way shows the code in 4 tiles, read digit by digit, and who gets it", async () => {
    await renderWithQuery(<JobScreen />);
    await loaded("Dan is on the way");

    expect(screen.getByText("Your arrival code")).toBeTruthy();
    const digits = screen.getByTestId("arrival-code-digits");
    expect(digits.props.accessibilityLabel).toBe("Arrival code: 0, 4, 2, 7");
    expect(digits.children).toHaveLength(4);
    expect(
      within(digits)
        .getAllByText(/^\d$/)
        .map((tile) => tile.props.children),
    ).toEqual(["0", "4", "2", "7"]);
    expect(screen.getByText("Give this code to Dan at the door.")).toBeTruthy();
  });

  it("a request with no job yet shows the booking state and keeps asking", async () => {
    fakeClock();
    failJob(new ApiError(404, "not_found"));
    await renderWithQuery(<JobScreen />);

    expect(await screen.findByTestId("job-booking")).toBeTruthy();
    expect(screen.getByRole("header", { name: "Your job isn't ready yet" })).toBeTruthy();
    expect(jobCalls()).toBe(1);

    answerJob(ON_THE_WAY);
    await advance(jobsConfig.pollMs);
    expect(await loaded("Dan is on the way")).toBeTruthy();
    expect(jobCalls()).toBe(2);
    expect(screen.queryByTestId("job-booking")).toBeNull();
  });

  it("a network error with nothing shown offers Try again, which asks again", async () => {
    failJob(new NetworkError(false));
    await renderWithQuery(<JobScreen />);

    expect(await screen.findByTestId("job-error")).toBeTruthy();
    expect(screen.getByRole("header", { name: "We couldn't load your job" })).toBeTruthy();
    expect(jobCalls()).toBe(1);

    answerJob(ON_THE_WAY);
    await act(async () => fireEvent.press(screen.getByRole("button", { name: "Try again" })));
    expect(await loaded("Dan is on the way")).toBeTruthy();
    expect(jobCalls()).toBe(2);
  });

  it("an id that is not a UUID shows not found, asks nothing, and goes Home", async () => {
    navigation.setParams({ id: "not-a-uuid" });
    await renderWithQuery(<JobScreen />);

    expect(screen.getByTestId("job-not-found")).toBeTruthy();
    expect(screen.getByRole("header", { name: "We couldn't find this job" })).toBeTruthy();
    await act(async () => fireEvent.press(screen.getByRole("button", { name: "Go to Home" })));
    expect(router.dismissTo).toHaveBeenCalledWith("/");
    await act(settle);
    expect(get).not.toHaveBeenCalled();
  });

  it("a focused job on the way is asked again every poll interval", async () => {
    fakeClock();
    await renderWithQuery(<JobScreen />);
    await loaded("Dan is on the way");
    expect(jobCalls()).toBe(1);

    await advance(jobsConfig.pollMs / 2);
    expect(jobCalls()).toBe(1);
    await advance(jobsConfig.pollMs / 2);
    await waitFor(() => expect(jobCalls()).toBe(2));
    await advance(jobsConfig.pollMs);
    await waitFor(() => expect(jobCalls()).toBe(3));
  });

  it.each([
    ["completed", COMPLETED, "Dan marked the job done"],
    ["confirmed", CONFIRMED, "Job confirmed"],
  ] as const)("a %s job is not polled", async (_name, item, title) => {
    fakeClock();
    answerJob(item);
    await renderWithQuery(<JobScreen />);
    await headline(title);

    await advance(jobsConfig.pollMs * 4);
    expect(jobCalls()).toBe(1);
  });

  it("a blur stops the polling; focus again asks at once and polling resumes", async () => {
    fakeClock();
    await renderWithQuery(<JobScreen />);
    await loaded("Dan is on the way");

    await setFocused(false);
    await advance(jobsConfig.pollMs * 3);
    expect(jobCalls()).toBe(1);

    await setFocused(true);
    await waitFor(() => expect(jobCalls()).toBe(2));
    await advance(jobsConfig.pollMs);
    await waitFor(() => expect(jobCalls()).toBe(3));
  });

  it("the background stops the polling; the foreground asks at once and polling resumes", async () => {
    fakeClock();
    await renderWithQuery(<JobScreen />);
    await loaded("Dan is on the way");

    await moveApp("background");
    await advance(jobsConfig.pollMs * 3);
    expect(jobCalls()).toBe(1);

    await moveApp("active");
    await waitFor(() => expect(jobCalls()).toBe(2));
    await advance(jobsConfig.pollMs);
    await waitFor(() => expect(jobCalls()).toBe(3));
  });

  it("an answer that lands after a sign-out never shows", async () => {
    const held = holdJob();
    await renderWithQuery(<JobScreen />);
    expect(screen.getByTestId("job-loading")).toBeTruthy();

    await signOut();
    await act(async () => held.resolve(ON_THE_WAY));
    await act(settle);

    expect(screen.queryByRole("header", { name: "Dan is on the way" })).toBeNull();
    expect(screen.queryByTestId("job-sheet")).toBeNull();
    expect(screen.queryByTestId("arrival-code")).toBeNull();
    expect(screen.queryByText(CODE, HIDDEN)).toBeNull();
    // The new generation's key is disabled: nothing is asked for it, the skeleton stays.
    expect(screen.getByTestId("job-loading")).toBeTruthy();
    expect(jobCalls()).toBe(1);
  });

  it("the arrival code never reaches a logger", async () => {
    fakeClock();
    const methods = ["log", "info", "warn", "error", "debug"] as const;
    const spies = methods.map((method) =>
      jest.spyOn(console, method).mockImplementation(() => undefined),
    );
    try {
      await renderWithQuery(<JobScreen />);
      await screen.findByTestId("arrival-code");
      await advance(jobsConfig.pollMs);
      await waitFor(() => expect(jobCalls()).toBe(2));
      await act(async () => pullToRefresh());
      await waitFor(() => expect(jobCalls()).toBe(3));
      expect(screen.getByTestId("arrival-code-digits")).toBeTruthy();

      const printed = spies.flatMap((spy) => spy.mock.calls.flat()).map(stringify);
      expect(printed.filter((text) => text.includes(CODE))).toEqual([]);
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
  });

  it("the pro row opens the pro's profile over the job", async () => {
    await renderWithQuery(<JobScreen />);
    await loaded("Dan is on the way");

    const row = await screen.findByRole("button", { name: "Dan K., verified, rated 4.8, 12 jobs" });
    expect(row.props.testID).toBe("job-pro");
    expect(row.props.accessibilityHint).toBe("Opens their profile");
    await act(async () => fireEvent.press(row));
    expect(router.push).toHaveBeenCalledWith({
      pathname: "/requests/[id]/quotes/[quoteId]/pro",
      params: { id: REQUEST_ID, quoteId: ACCEPTED.id, from: "job" },
    });
  });

  it("a sign-out stops the polling", async () => {
    // The signed-out screen falls back to the skeleton: its endless pulse would never let fake
    // timers drain, and motion is not what this case is about.
    jest.mocked(useReducedMotion).mockReturnValue(true);
    fakeClock();
    await renderWithQuery(<JobScreen />);
    await loaded("Dan is on the way");
    expect(jobCalls()).toBe(1);

    await signOut();
    await advance(jobsConfig.pollMs * 3);
    expect(jobCalls()).toBe(1);
  });

  it("says the map is an estimate while the pro is on the way, and only then", async () => {
    await renderWithQuery(<JobScreen />);
    await loaded("Dan is on the way");
    expect(screen.getByTestId("job-map-note").props.children).toBe(
      "The map is an estimate from the arrival time, not a live location.",
    );

    await screen.unmount();
    answerJob(WORKING);
    await renderWithQuery(<JobScreen />);
    await loaded("Dan is working");
    expect(screen.queryByTestId("job-map-note")).toBeNull();
  });

  it("the way back stays reachable to screen readers while the job loads", async () => {
    holdJob();
    await renderWithQuery(<JobScreen />);

    expect(screen.getByTestId("job-loading")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();
  });

  it("a failed look-up of the accepted quote is asked again with the next answer", async () => {
    fakeClock();
    let quotesOk = false;
    api.quotes = () =>
      quotesOk ? Promise.resolve(QUOTE_LIST) : Promise.reject(new Error("offline"));
    await renderWithQuery(<JobScreen />);
    await headline("Dan is on the way");
    await waitFor(() =>
      expect(get.mock.calls.filter(([path]) => path === QUOTES_PATH)).toHaveLength(1),
    );
    expect(screen.queryByRole("button", { name: /^Dan K\./ })).toBeNull();

    quotesOk = true;
    await advance(jobsConfig.pollMs);
    expect(await screen.findByRole("button", { name: /^Dan K\./ })).toBeTruthy();
  });

  it("the countdown turns with the ETA, not a minute late", async () => {
    fakeClock();
    // 90 s away: "in 2 min"; 30 s later "in 1 min"; at the ETA "any minute now".
    answerJob(job({ ...ON_THE_WAY, eta_at: new Date(NOW + 90_000).toISOString() }));
    await renderWithQuery(<JobScreen />);
    await loaded("Dan is on the way");
    const support = () => screen.getByTestId("job-support").props.children as string;
    expect(support()).toContain(`in${NBSP}2${NBSP}min`);

    await advance(30_000);
    await waitFor(() => expect(support()).toContain(`in${NBSP}1${NBSP}min`));
    await advance(60_000);
    await waitFor(() => expect(support()).toBe("Arriving any minute now"));
  });

  it("the pro row is not a button while the accepted quote is unknown", async () => {
    const held = deferred<CustomerQuoteList>();
    api.quotes = () => held.promise;
    await renderWithQuery(<JobScreen />);
    await headline("Dan is on the way");

    const row = screen.getByTestId("job-pro");
    expect(row.props.accessibilityRole).toBeUndefined();
    expect(row.props.accessibilityLabel).toBe("Dan K., verified, rated 4.8, 12 jobs");
    expect(screen.queryByRole("button", { name: /^Dan K\./ })).toBeNull();

    await act(async () => held.resolve(QUOTE_LIST));
    expect(await screen.findByRole("button", { name: /^Dan K\./ })).toBeTruthy();
  });

  it("a phase change while open is announced once; the first answer is not", async () => {
    fakeClock();
    await renderWithQuery(<JobScreen />);
    await loaded("Dan is on the way");
    expect(announced()).toEqual([]);

    answerJob(ARRIVED);
    await advance(jobsConfig.pollMs);
    expect(await loaded("Dan has arrived")).toBeTruthy();
    expect(announced()).toEqual(["Dan has arrived"]);

    await advance(jobsConfig.pollMs);
    await waitFor(() => expect(jobCalls()).toBe(3));
    expect(announced()).toEqual(["Dan has arrived"]);
  });

  it.each([
    [1_485, 19_485, "$194.85", "Includes $14.85 in tax", "Paid $194.85, including $14.85 in tax"],
    [0, 18_000, "$180.00", null, "Paid $180.00"],
  ] as const)(
    "the paid row with tax %s shows the total with cents",
    async (tax, total, shown, taxLine, label) => {
      answerJob(job({ ...ON_THE_WAY, tax_cents: tax, customer_total_cents: total }));
      await renderWithQuery(<JobScreen />);
      await loaded("Dan is on the way");

      const paid = within(screen.getByTestId("job-paid"));
      expect(paid.getByText("Paid")).toBeTruthy();
      expect(paid.getByText(shown)).toBeTruthy();
      expect(paid.queryByText(/in tax$/)?.props.children ?? null).toBe(taxLine);
      expect(screen.getByTestId("job-paid").props.accessibilityLabel).toBe(label);
    },
  );

  it("the timeline lists the known events newest first, each with its time", async () => {
    answerJob(WORKING);
    await renderWithQuery(<JobScreen />);
    await loaded("Dan is working");

    expect(screen.getByRole("header", { name: "What's happened" })).toBeTruthy();
    const rows = screen.getAllByTestId(/^job-timeline-\d+$/);
    expect(rows.map((row) => row.props.accessibilityLabel)).toEqual([
      `Started working, ${clock(STARTED.at)}`,
      `Arrived, ${clock(CHECKED_IN.at)}`,
      `New arrival time, ${clock(ETA_MOVED.at)}`,
      `On the way, ${clock(LEFT.at)}`,
      `Booked and paid, ${clock(CREATED.at)}`,
    ]);
  });

  it("shows the loading skeleton until the job arrives", async () => {
    const held = holdJob();
    await renderWithQuery(<JobScreen />);

    const loading = screen.getByRole("progressbar", { name: "Loading your job" });
    expect(loading.props.testID).toBe("job-loading");
    expect(screen.queryByTestId("job-sheet")).toBeNull();

    await act(async () => held.resolve(ON_THE_WAY));
    expect(await loaded("Dan is on the way")).toBeTruthy();
    expect(screen.queryByTestId("job-loading")).toBeNull();
  });

  it("reads in Spanish", async () => {
    await act(() => i18n.changeLanguage("es"));
    await renderWithQuery(<JobScreen />);

    expect(await loaded("Dan va en camino")).toBeTruthy();
    expect(screen.getByText("Tu código de llegada")).toBeTruthy();
  });

  it.each([
    [false, true],
    [true, false],
  ])("reduce motion %s: the marker pulses %s while on the way", async (reduce, pulses) => {
    jest.mocked(useReducedMotion).mockReturnValue(reduce);
    await renderWithQuery(<JobScreen />);
    await loaded("Dan is on the way");

    expect(screen.getByTestId("job-map-marker", HIDDEN)).toBeTruthy();
    expect(screen.queryByTestId("job-map-pulse", HIDDEN) !== null).toBe(pulses);
  });
});

describe("JobScreen, the finished job (#66)", () => {
  const FINISHED_JOB = job({
    status: "completed",
    confirm_by: at(20),
    timeline: COMPLETED.timeline,
    photos: { before: [], after: [afterPhoto(1), afterPhoto(2)], pending: 0 },
  });
  const CONFIRMED_JOB = job({
    status: "confirmed",
    timeline: CONFIRMED.timeline,
    photos: FINISHED_JOB.photos,
  });
  const time = (iso: string) =>
    new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(new Date(iso));
  const photoNames = () =>
    screen.getAllByRole("imagebutton").map((photo) => photo.props.accessibilityLabel as string);
  const grows = () =>
    jest
      .mocked(withTiming)
      .mock.calls.filter(([to, config]) => to === 1 && config?.duration === stepSlideMs);

  beforeEach(() => jest.mocked(withTiming).mockClear());

  it("leads with the pro's word and the after photos, and docks the confirmation with its deadline", async () => {
    answerJob(FINISHED_JOB);
    await renderWithQuery(<JobScreen />);

    expect(await headline("Dan marked the job done")).toBeTruthy();
    expect(screen.getByTestId("job-support").props.children).toBe(
      "Take a look at the work, then confirm it's done.",
    );
    expect(photoNames()).toEqual([
      "Photo of the finished work, 1 of 2",
      "Photo of the finished work, 2 of 2",
    ]);
    expect(screen.getByTestId("job-photo-hero-0").props.accessibilityHint).toBe(
      "Opens it full screen",
    );
    expect(within(screen.getByTestId("job-photo-hero-count", HIDDEN)).getByText("1 of 2", HIDDEN));
    expect(screen.getByTestId("job-paid")).toBeTruthy();
    // A screen of its own: no steps, no code, no map behind the photos.
    expect(screen.queryByTestId("job-milestones")).toBeNull();
    expect(screen.queryByTestId("arrival-code")).toBeNull();
    expect(screen.queryByTestId("job-map", HIDDEN)).toBeNull();
    expect(screen.getByTestId("job-confirm-deadline").props.children).toBe(
      `Confirms automatically today at ${time(at(20))} if you don't answer.`,
    );

    await act(async () =>
      fireEvent.press(screen.getByRole("button", { name: "Confirm the job is done" })),
    );
    expect(router.push).toHaveBeenCalledWith({
      pathname: "/requests/[id]/confirm",
      params: { id: REQUEST_ID },
    });
  });

  it("a photo opens full screen at that photo", async () => {
    answerJob(FINISHED_JOB);
    await renderWithQuery(<JobScreen />);
    await headline("Dan marked the job done");

    await act(async () => fireEvent.press(screen.getByTestId("job-photo-hero-1")));
    expect(router.push).toHaveBeenCalledWith({
      pathname: "/requests/[id]/photos",
      params: { id: REQUEST_ID, index: "1" },
    });
  });

  it("with no photo listed yet, the drawn map stands in and the dock still confirms", async () => {
    answerJob({ ...FINISHED_JOB, photos: { before: [], after: [], pending: 1 } });
    await renderWithQuery(<JobScreen />);
    await headline("Dan marked the job done");

    expect(screen.queryByTestId("job-photo-hero")).toBeNull();
    expect(screen.getByTestId("job-map", HIDDEN)).toBeTruthy();
    expect(screen.getByTestId("job-confirm")).toBeTruthy();
  });

  it("a photo whose link expires turns to a quiet frame, and the job is asked for again", async () => {
    fakeClock();
    const expiring = afterPhoto(1, { expires_at: at(5) });
    answerJob({ ...FINISHED_JOB, photos: { ...FINISHED_JOB.photos, after: [expiring] } });
    await renderWithQuery(<JobScreen />);
    await headline("Dan marked the job done");
    expect(screen.getByTestId("job-photo-hero-0-image")).toBeTruthy();

    const held = holdJob();
    // The photos' clock moves a minute at a time (`useExpiryClock`).
    for (let minute = 0; minute < 5; minute += 1) await advance(MINUTE_MS);

    expect(screen.getByTestId("job-photo-hero-0-frame")).toBeTruthy();
    expect(screen.queryByTestId("job-photo-hero-0-image")).toBeNull();
    expect(jobCalls()).toBe(2);
    await act(async () => held.resolve(FINISHED_JOB));
    expect(await screen.findByTestId("job-photo-hero-0-image")).toBeTruthy();
  });

  it("an image that fails to load shows the frame, never a broken picture", async () => {
    answerJob(FINISHED_JOB);
    await renderWithQuery(<JobScreen />);
    await headline("Dan marked the job done");

    await act(async () => screen.getByTestId("job-photo-hero-0-image").props.onError());
    expect(screen.getByTestId("job-photo-hero-0-frame")).toBeTruthy();
  });

  /** The customer confirms from the sheet over the screen, which is blurred meanwhile. */
  async function confirmHere(client: QueryClient) {
    post.mockResolvedValue(CONFIRMED_JOB);
    await setFocused(false);
    await act(async () => {
      await confirmJob(client, REQUEST_ID, 1);
    });
  }

  it("confirmed here: thanks, said once the screen is back in focus, the seal grows, the dock leaves", async () => {
    answerJob(FINISHED_JOB);
    const client = newQueryClient();
    await renderWithQuery(<JobScreen />, client);
    await headline("Dan marked the job done");

    await confirmHere(client);

    expect(await headline("Thanks! Job confirmed")).toBeTruthy();
    // Under the sheet nothing is said: the sheet closing would cut it short.
    expect(announced()).toEqual([]);
    await setFocused(true);
    expect(announced()).toEqual(["Thanks! Job confirmed"]);
    expect(screen.getByTestId("job-support").props.children).toBe("Payment is released to Dan.");
    expect(screen.queryByTestId("job-confirm-dock")).toBeNull();
    expect(grows()).toHaveLength(1);

    // The work stays to look at: the photos as tiles under a title, each opening full screen.
    expect(screen.getByRole("header", { name: "The finished work" })).toBeTruthy();
    expect(photoNames()).toEqual([
      "Photo of the finished work, 1 of 2",
      "Photo of the finished work, 2 of 2",
    ]);
    await act(async () => fireEvent.press(screen.getByTestId("job-photo-thumb-0")));
    expect(router.push).toHaveBeenCalledWith({
      pathname: "/requests/[id]/photos",
      params: { id: REQUEST_ID, index: "0" },
    });
  });

  it("under Reduce Motion the seal simply stands", async () => {
    jest.mocked(useReducedMotion).mockReturnValue(true);
    answerJob(FINISHED_JOB);
    const client = newQueryClient();
    await renderWithQuery(<JobScreen />, client);
    await headline("Dan marked the job done");

    await confirmHere(client);

    expect(await headline("Thanks! Job confirmed")).toBeTruthy();
    expect(grows()).toHaveLength(0);
  });

  it("the automatic confirmation landing under the customer's eyes is just 'Job confirmed'", async () => {
    answerJob(FINISHED_JOB);
    await renderWithQuery(<JobScreen />);
    await headline("Dan marked the job done");

    answerJob(CONFIRMED_JOB);
    await act(async () => pullToRefresh());

    expect(await headline("Job confirmed")).toBeTruthy();
    expect(screen.queryByText("Thanks! Job confirmed")).toBeNull();
    expect(announced()).toEqual(["Job confirmed"]);
    expect(grows()).toHaveLength(0);
  });

  it("once the confirmation is due it is asked for, then polled until the worker confirms it", async () => {
    fakeClock();
    answerJob(FINISHED_JOB);
    await renderWithQuery(<JobScreen />);
    await headline("Dan marked the job done");

    await advance(10 * MINUTE_MS);
    expect(jobCalls()).toBe(1);
    // The clock reaches confirm_by (20 min): the words say so and the job is asked for again.
    for (let minute = 0; minute < 10; minute += 1) await advance(MINUTE_MS);
    expect(screen.getByTestId("job-confirm-deadline").props.children).toBe(
      "Confirms automatically any moment now.",
    );
    await waitFor(() => expect(jobCalls()).toBe(2));

    answerJob(CONFIRMED_JOB);
    await advance(jobsConfig.pollMs);
    await waitFor(() => expect(jobCalls()).toBe(3));
    expect(await headline("Job confirmed")).toBeTruthy();
    expect(screen.queryByTestId("job-confirm-dock")).toBeNull();

    await advance(jobsConfig.pollMs * 3);
    expect(jobCalls()).toBe(3);
  });

  it("a finished job found gone (404) stays to look at, with nothing left to confirm", async () => {
    answerJob(FINISHED_JOB);
    await renderWithQuery(<JobScreen />);
    await headline("Dan marked the job done");

    failJob(new ApiError(404, "not_found"));
    await act(async () => pullToRefresh());

    await waitFor(() => expect(screen.queryByTestId("job-confirm-dock")).toBeNull());
    expect(screen.getByTestId("job-finished")).toBeTruthy();
  });

  it("a photo tap and Confirm in a row open only the first", async () => {
    answerJob(FINISHED_JOB);
    await renderWithQuery(<JobScreen />);
    await headline("Dan marked the job done");
    navigation.setNavigating(true);

    await act(async () => fireEvent.press(screen.getByTestId("job-photo-hero-0")));
    await act(async () => fireEvent.press(screen.getByTestId("job-confirm")));

    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith({
      pathname: "/requests/[id]/photos",
      params: { id: REQUEST_ID, index: "0" },
    });
  });

  it("opened confirmed, it says Job confirmed, calmly: no thanks, no seal growing, no dock", async () => {
    answerJob(CONFIRMED_JOB);
    await renderWithQuery(<JobScreen />);

    expect(await headline("Job confirmed")).toBeTruthy();
    expect(screen.queryByText("Thanks! Job confirmed")).toBeNull();
    expect(screen.queryByTestId("job-confirm-dock")).toBeNull();
    expect(grows()).toHaveLength(0);
  });

  it("an answer after a sign-out never draws the finished job", async () => {
    const held = holdJob();
    await renderWithQuery(<JobScreen />);
    await signOut();
    await act(async () => held.resolve(FINISHED_JOB));

    expect(screen.queryByTestId("job-finished")).toBeNull();
    expect(screen.queryByTestId("job-confirm-dock")).toBeNull();
  });

  it("speaks Spanish", async () => {
    await act(() => i18n.changeLanguage("es"));
    answerJob(FINISHED_JOB);
    await renderWithQuery(<JobScreen />);

    expect(await headline("Dan marcó el trabajo como terminado")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Confirmar que está terminado" })).toBeTruthy();
    expect(screen.getByTestId("job-confirm-deadline").props.children).toMatch(
      /^Se confirma automáticamente hoy a las? \d{1,2}:\d{2} si no respondes\.$/,
    );
    expect(photoNames()[0]).toBe("Foto del trabajo terminado, 1 de 2");
  });
});

/** One console argument as text, whatever it is. */
function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return `${value.message} ${value.stack ?? ""}`;
  try {
    return `${JSON.stringify(value)} ${String(value)}`;
  } catch {
    return String(value);
  }
}
