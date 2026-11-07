import i18n from "@/i18n";

import { QueryClientProvider } from "@tanstack/react-query";
import { router, Slot, useLocalSearchParams } from "expo-router";
import { act, fireEvent, renderRouter, screen, waitFor, within } from "expo-router/testing-library";
import { createElement } from "react";
import { AppState, Text, type AppStateStatus } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { ApiError, apiGet, useSession } from "@/api";
import { formatLocale } from "@/features/quotes/format";

import AppLayout, { unstable_settings as appSettings } from "../../../app/(app)/_layout";
import { AccountScreen } from "../../account/AccountScreen";
import { METRICS } from "../../auth/__tests__/helpers";
import type { RequestSummary } from "../../history/useMyRequests";
import { HistoryScreen } from "../../history/HistoryScreen";
import { CATEGORIES, newQueryClient, signedIn } from "../../home/__tests__/helpers";
import { HomeScreen } from "../../home/HomeScreen";
import { freezeClock, NOW } from "../../quotes/__tests__/helpers";
import { TabsLayout } from "../../tabs/TabsLayout";
import { activeJobQueryKey } from "../api";
import {
  formatShortStart,
  type CustomerJob,
  type JobStatus,
  type JobTimelineEntry,
} from "../phase";

jest.mock("@/api", () => ({
  ...jest.requireActual("../../../api/errors"),
  onSignOut: jest.fn(),
  apiConfig: { timeoutMs: 15_000 },
  apiGet: jest.fn(),
  isCurrentGeneration: jest.fn(() => true),
  sessionGeneration: jest.fn(() => 1),
  useSessionGeneration: jest.fn(() => 1),
  setSessionUser: jest.fn(),
  useSession: jest.fn(),
  logout: jest.fn(),
}));
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const at = (minutes: number) => new Date(NOW + minutes * MINUTE_MS).toISOString();
const CODE = "4821";
const REQUESTS_PATH = "/v1/requests";
const JOB_PATH = "/v1/requests/{request_id}/job";
const NBSP = " ";

const requestId = (n: number) => `6f1c2a40-0000-4000-8000-00000000064${n}`;

const request = (n: number, status: RequestSummary["status"]): RequestSummary => ({
  id: requestId(n),
  public_code: `JF-00064${n}`,
  status,
  customer_status: status === "accepted" ? "customerStatus.scheduled" : "customerStatus.quoteReady",
  category_id: null,
  created_at: at(-60 * n),
  media_count: 0,
});

const entry = (type: string, status: JobStatus | null, minutes: number): JobTimelineEntry => ({
  type,
  status,
  at: at(minutes),
});

const job = (status: JobStatus, overrides: Partial<CustomerJob> = {}): CustomerJob => ({
  id: "9a000000-0000-4000-8000-000000000064",
  status,
  customer_status: "customerStatus.scheduled",
  scheduled_start_at: at(19 * 60),
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
  timeline: [entry("created", "scheduled", -120)],
  amount_cents: 18_000,
  tax_cents: 0,
  customer_total_cents: 18_000,
  // The pro's photos (#298): none here; the screen does not show them yet.
  photos: { before: [], after: [], pending: 0 },
  // Chat messages not read yet (#71): none; the screen does not show them yet.
  unread_messages: 0,
  ...overrides,
});

const LEFT = entry("status_changed", "on_the_way", -5);
const SCHEDULED = job("scheduled", { arrival_code: CODE });
const ON_THE_WAY = job("on_the_way", {
  eta_at: at(12),
  arrival_code: CODE,
  timeline: [entry("created", "scheduled", -120), LEFT],
});
const ARRIVED = job("on_the_way", {
  eta_at: at(12),
  timeline: [entry("created", "scheduled", -120), LEFT, entry("checked_in", null, -1)],
});
const WORKING = job("in_progress", {
  timeline: [entry("created", "scheduled", -120), entry("status_changed", "in_progress", -1)],
});
const FINISHED = job("completed");

/** The scheduled line's date, worded with the same call the banner uses. */
const scheduledFor = (iso: string) => formatShortStart(iso, formatLocale());

// What the mocked API answers: the newest page of requests, and each request's job (or a 404).
const mockApi = {
  requests: [] as RequestSummary[],
  jobs: {} as Record<string, CustomerJob>,
};

let client = newQueryClient();

function Root() {
  return createElement(
    GestureHandlerRootView,
    { style: { flex: 1 } },
    createElement(
      SafeAreaProvider,
      { initialMetrics: METRICS },
      createElement(QueryClientProvider, { client }, createElement(Slot)),
    ),
  );
}

function JobStub() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <Text testID="job-stub">{`job ${id}`}</Text>;
}

const routes = {
  _layout: Root,
  "(app)/_layout": { default: AppLayout, unstable_settings: appSettings },
  "(app)/(tabs)/_layout": TabsLayout,
  "(app)/(tabs)/index": HomeScreen,
  "(app)/(tabs)/history": HistoryScreen,
  "(app)/(tabs)/account": AccountScreen,
  "(app)/requests/[id]/job": JobStub,
};

type ApiOptions = { generation?: number; params?: { request_id?: string } };
const calls = () => jest.mocked(apiGet).mock.calls as unknown as [string, ApiOptions?][];
/** The banner's reads of the requests page: History's own list asks without a generation. */
const bannerReads = () =>
  calls().filter(([path, options]) => path === REQUESTS_PATH && options?.generation !== undefined)
    .length;
const jobReads = () => calls().filter(([path]) => path === JOB_PATH).length;

/** Tells every AppState listener subscribed so far that the app moved to `state`. */
async function moveApp(state: AppStateStatus): Promise<void> {
  const listeners = jest
    .mocked(AppState.addEventListener)
    .mock.calls.map(([, listener]) => listener as (next: AppStateStatus) => void);
  await act(async () => listeners.forEach((listener) => listener(state)));
}

/** The banner's chain answered (or refused): what it shows now is what it will show. */
const settled = () =>
  waitFor(() => expect(client.getQueryState(activeJobQueryKey(1))?.status).toBe("success"));

/** Every text the banner draws, joined. */
const bannerTexts = () =>
  within(screen.getByTestId("job-banner"))
    .getAllByText(/.+/)
    .map((node) => [node.props.children].flat().join(""))
    .join(" ");

async function expectBanner(line: string) {
  const banner = await screen.findByTestId("job-banner");
  expect(banner.props.accessibilityLabel).toBe(line);
  // Drawn in two parts (the sentence, then the time it ends with), read together as the line.
  const drawn = within(banner)
    .getAllByText(/./)
    .map((part) => [part.props.children as string | string[]].flat().join(""))
    .join("");
  expect(drawn).toBe(line);
  expect(screen.getByTestId("tab-bar-accessory")).toBeTruthy();
}

beforeEach(() => {
  freezeClock();
  client = newQueryClient();
  // RN's AppState mock keeps every listener ever added: only this test's trees are told.
  jest.mocked(AppState.addEventListener).mockClear();
  mockApi.requests = [];
  mockApi.jobs = {};
  jest.mocked(useSession).mockReturnValue(signedIn({ role: "customer" }));
  jest
    .mocked(apiGet)
    .mockReset()
    .mockImplementation((async (path: string, options?: ApiOptions) => {
      if (path === REQUESTS_PATH) return { items: mockApi.requests, next_cursor: null };
      if (path === JOB_PATH) {
        const found = mockApi.jobs[options?.params?.request_id ?? ""];
        if (!found) throw new ApiError(404, "not_found");
        return found;
      }
      return CATEGORIES;
    }) as unknown as typeof apiGet);
});

afterEach(async () => {
  jest.useRealTimers();
  await act(() => i18n.changeLanguage("en"));
});

describe("the tabs' job banner (#64)", () => {
  it.each([
    ["scheduled", SCHEDULED, `Dan is booked · ${scheduledFor(SCHEDULED.scheduled_start_at)}`],
    ["on the way, close", ON_THE_WAY, `Dan is on the way · 12${NBSP}min`],
    ["arrived", ARRIVED, "Dan has arrived"],
    ["working", WORKING, "Dan is working"],
    ["finished", FINISHED, "Dan finished the job"],
  ] as const)("shows on Home, History and Account while %s", async (_, active, line) => {
    mockApi.requests = [request(1, "accepted"), request(2, "quote_ready")];
    mockApi.jobs = { [requestId(1)]: active };
    await renderRouter(routes, { initialUrl: "/" });

    expect(screen.getByTestId("customer-home")).toBeTruthy();
    await expectBanner(line);

    await act(async () => fireEvent.press(screen.getByTestId("tab-history")));
    expect(screen.getByRole("header", { name: "Your requests" })).toBeTruthy();
    await expectBanner(line);

    await act(async () => fireEvent.press(screen.getByTestId("tab-account")));
    expect(screen.getByTestId("account-log-out")).toBeTruthy();
    await expectBanner(line);

    // Only the accepted request's job is asked for.
    const asked = calls()
      .filter(([path]) => path === JOB_PATH)
      .map(([, options]) => options?.params?.request_id);
    expect(asked.length).toBeGreaterThan(0);
    expect(new Set(asked)).toEqual(new Set([requestId(1)]));
  });

  it("is hidden with no accepted request, and no job is asked for", async () => {
    mockApi.requests = [request(1, "quote_ready"), request(2, "finding_pro")];
    await renderRouter(routes, { initialUrl: "/" });
    await settled();

    expect(screen.queryByTestId("job-banner")).toBeNull();
    expect(screen.queryByTestId("tab-bar-accessory")).toBeNull();
    expect(jobReads()).toBe(0);
  });

  it("is hidden while the accepted request has no job yet (404: not paid)", async () => {
    mockApi.requests = [request(1, "accepted")];
    await renderRouter(routes, { initialUrl: "/" });
    await settled();

    expect(jobReads()).toBeGreaterThan(0);
    expect(screen.queryByTestId("job-banner")).toBeNull();
    expect(screen.queryByTestId("tab-bar-accessory")).toBeNull();
  });

  it.each(["confirmed", "paid_out", "disputed", "cancelled"] as const)(
    "is hidden once the job is %s",
    async (status) => {
      mockApi.requests = [request(1, "accepted")];
      mockApi.jobs = { [requestId(1)]: job(status) };
      await renderRouter(routes, { initialUrl: "/" });
      await settled();

      expect(jobReads()).toBeGreaterThan(0);
      expect(screen.queryByTestId("job-banner")).toBeNull();
      expect(screen.queryByTestId("tab-bar-accessory")).toBeNull();
    },
  );

  it("is hidden for a pro, who never asks for the customer's requests", async () => {
    jest.mocked(useSession).mockReturnValue(signedIn({ role: "pro" }));
    mockApi.requests = [request(1, "accepted")];
    mockApi.jobs = { [requestId(1)]: ON_THE_WAY };
    await renderRouter(routes, { initialUrl: "/history" });
    await act(async () => {
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });

    expect(screen.getAllByRole("tab")).toHaveLength(3);
    expect(screen.queryByTestId("job-banner")).toBeNull();
    expect(screen.queryByTestId("tab-bar-accessory")).toBeNull();
    expect(calls().some(([path]) => path === REQUESTS_PATH)).toBe(false);
    expect(jobReads()).toBe(0);

    // A refresh of a disabled query would still go out (TanStack's refetch ignores `enabled`).
    await act(async () => fireEvent.press(screen.getByTestId("tab-account")));
    await act(async () => fireEvent.press(screen.getByTestId("tab-home")));
    await moveApp("active");
    await act(async () => {
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });
    expect(calls().some(([path]) => path === REQUESTS_PATH)).toBe(false);
  });

  it("a tap opens the job screen for that request, and Back returns to the tab", async () => {
    mockApi.requests = [request(1, "accepted")];
    mockApi.jobs = { [requestId(1)]: ON_THE_WAY };
    const view = await renderRouter(routes, { initialUrl: "/history" });
    const banner = await screen.findByTestId("job-banner");
    expect(banner.props.accessibilityRole).toBe("button");
    expect(banner.props.accessibilityHint).toBe("Opens your job");

    await act(async () => fireEvent.press(banner));

    expect((await screen.findByTestId("job-stub")).props.children).toBe(`job ${requestId(1)}`);
    expect(view.getPathname()).toBe(`/requests/${requestId(1)}/job`);

    const before = bannerReads();
    await act(() => router.back());

    expect(view.getPathname()).toBe("/history");
    // Back on the tabs, the banner asks again: the job may have moved while it was open.
    await waitFor(() => expect(bannerReads()).toBe(before + 1));
    expect(screen.queryByTestId("job-stub")).toBeNull();
    expect(screen.getByRole("header", { name: "Your requests" })).toBeTruthy();
    await expectBanner(`Dan is on the way · 12${NBSP}min`);
  });

  it.each([
    ["scheduled", SCHEDULED],
    ["on the way", ON_THE_WAY],
  ] as const)("never carries the arrival code (%s)", async (_, active) => {
    expect(active.arrival_code).toBe(CODE);
    mockApi.requests = [request(1, "accepted")];
    mockApi.jobs = { [requestId(1)]: active };
    await renderRouter(routes, { initialUrl: "/" });
    const banner = await screen.findByTestId("job-banner");

    expect(banner.props.accessibilityLabel).not.toContain(CODE);
    expect(bannerTexts()).not.toContain(CODE);
    expect(screen.queryByText(new RegExp(CODE), { includeHiddenElements: true })).toBeNull();
  });

  it("with two active jobs, the pro on the way wins over a scheduled one", async () => {
    // The scheduled job's request is the newer one, listed first.
    mockApi.requests = [request(1, "accepted"), request(2, "accepted")];
    mockApi.jobs = {
      [requestId(1)]: job("scheduled", {
        scheduled_start_at: new Date(NOW + 2 * HOUR_MS).toISOString(),
        pro: { ...SCHEDULED.pro, name: "María P." },
      }),
      [requestId(2)]: ON_THE_WAY,
    };
    await renderRouter(routes, { initialUrl: "/" });

    await expectBanner(`Dan is on the way · 12${NBSP}min`);
    await act(async () => fireEvent.press(screen.getByTestId("job-banner")));
    expect((await screen.findByTestId("job-stub")).props.children).toBe(`job ${requestId(2)}`);
  });

  it("is asked for once on mount and again on each move to another tab", async () => {
    mockApi.requests = [request(1, "accepted")];
    mockApi.jobs = { [requestId(1)]: ON_THE_WAY };
    await renderRouter(routes, { initialUrl: "/" });
    await screen.findByTestId("job-banner");
    await settled();
    expect(bannerReads()).toBe(1);

    await act(async () => fireEvent.press(screen.getByTestId("tab-history")));
    await waitFor(() => expect(bannerReads()).toBe(2));

    await act(async () => fireEvent.press(screen.getByTestId("tab-account")));
    await waitFor(() => expect(bannerReads()).toBe(3));

    await act(async () => fireEvent.press(screen.getByTestId("tab-home")));
    await waitFor(() => expect(bannerReads()).toBe(4));
  });

  it("is asked for again when the app returns to the foreground on the tabs", async () => {
    mockApi.requests = [request(1, "accepted")];
    mockApi.jobs = { [requestId(1)]: ON_THE_WAY };
    await renderRouter(routes, { initialUrl: "/" });
    await screen.findByTestId("job-banner");
    await settled();
    const before = bannerReads();

    await moveApp("background");
    expect(bannerReads()).toBe(before);
    await moveApp("active");
    await waitFor(() => expect(bannerReads()).toBeGreaterThan(before));
  });

  it("a fresh answer moves the banner: the job the pro moved on shows on the next tab", async () => {
    mockApi.requests = [request(1, "accepted")];
    mockApi.jobs = { [requestId(1)]: SCHEDULED };
    await renderRouter(routes, { initialUrl: "/" });
    await expectBanner(`Dan is booked · ${scheduledFor(SCHEDULED.scheduled_start_at)}`);

    mockApi.jobs = { [requestId(1)]: ON_THE_WAY };
    await act(async () => fireEvent.press(screen.getByTestId("tab-history")));

    await waitFor(() =>
      expect(screen.getByTestId("job-banner").props.accessibilityLabel).toBe(
        `Dan is on the way · 12${NBSP}min`,
      ),
    );
  });
});
