import "@/i18n";

import { act, fireEvent, screen, waitFor, within } from "@testing-library/react-native";
import { router } from "expo-router";
import { AppState, type AppStateStatus } from "react-native";

import { apiGet, NetworkError, useSession } from "@/api";
import { formatInstantDay, formatTimeOfDay } from "@/features/opportunities/format";
import { formatLocale } from "@/features/quotes/format";

import { deferred, settle } from "../../../api/__tests__/helpers";
import { SIGNED_OUT } from "../../auth/__tests__/helpers";
import type { ProJob, ProJobPage } from "../phase";
import { YourJobs } from "../YourJobs";
import {
  apiMock,
  arrived,
  freezeClock,
  jobN,
  jobPage,
  navigation,
  NOW,
  proJob,
  renderWithQuery,
  signedIn,
  working,
} from "./helpers";

jest.mock("@/api", () => jest.requireActual("./helpers").apiMock());
jest.mock(
  "expo-router",
  () => jest.requireActual("../../opportunities/__tests__/helpers").routerMock,
);
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);
// The row placeholder pulses forever otherwise; Reduce Motion draws it still.
jest.mock("react-native-reanimated", () => {
  const actual =
    jest.requireActual<typeof import("react-native-reanimated")>("react-native-reanimated");
  return { __esModule: true, ...actual, useReducedMotion: jest.fn(() => true) };
});

const LIST = "/v1/pros/me/jobs";
const ROW_ID = /^pro-job-[0-9a-f-]{36}$/;
// The row's lines are hidden from assistive technology (its label says it all).
const HIDDEN = { includeHiddenElements: true };
const NBSP = String.fromCodePoint(0xa0);

const { accessToken: _token, accessTokenExpiresAt: _expires, ...SIGNED_OUT_SESSION } = SIGNED_OUT;
const mockSession = jest.requireMock<ReturnType<typeof apiMock>>("@/api").mockSession;

/** A time on the device's calendar, `days` after NOW's local day, so Today/Tomorrow hold in any zone. */
function localAt(days: number, hours: number, minutes = 0): string {
  const now = new Date(NOW);
  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + days,
    hours,
    minutes,
  ).toISOString();
}

const timeOf = (iso: string) => formatTimeOfDay(Date.parse(iso), formatLocale());

const TODAY_EARLY = localAt(0, 9);
const TODAY_LATE = localAt(0, 18, 30);
const TOMORROW = localAt(1, 8);
const NEXT_WEEK = localAt(7, 10);

const rowIds = () =>
  screen
    .queryAllByTestId(ROW_ID)
    .map((row) => (row.props.testID as string).slice("pro-job-".length));
const row = (id: string) => screen.getByTestId(`pro-job-${id}`);
const rowLabel = (id: string): unknown => row(id).props.accessibilityLabel;
const line = (id: string, part: string) => screen.getByTestId(`pro-job-${id}-${part}`, HIDDEN);
const findRow = (id: string) => screen.findByTestId(`pro-job-${id}`);
const listCalls = () => jest.mocked(apiGet).mock.calls.filter(([path]) => path === LIST);

const answer = (page: ProJobPage) => jest.mocked(apiGet).mockResolvedValueOnce(page);

async function press(element: Parameters<typeof fireEvent.press>[0]): Promise<void> {
  await act(async () => fireEvent.press(element));
}

beforeEach(() => {
  freezeClock();
  navigation.reset();
  mockSession.generation = 1;
  jest.mocked(useSession).mockReturnValue(signedIn({ role: "pro", first_name: "Dan" }));
  jest.mocked(apiGet).mockReset();
  jest.mocked(router.push).mockClear();
  jest.mocked(AppState.addEventListener).mockClear();
});

afterEach(() => {
  jest.useRealTimers();
});

describe("YourJobs", () => {
  it("shows a placeholder labelled Loading your jobs until the jobs arrive", async () => {
    const held = deferred<ProJobPage>();
    jest.mocked(apiGet).mockReturnValueOnce(held.promise);
    await renderWithQuery(<YourJobs />);

    expect(screen.getByText("Your jobs")).toBeTruthy();
    const loading = screen.getByTestId("your-jobs-loading");
    expect(loading.props.accessibilityRole).toBe("progressbar");
    expect(loading.props.accessibilityLabel).toBe("Loading your jobs");
    expect(screen.getByRole("progressbar", { name: "Loading your jobs" })).toBeTruthy();
    expect(rowIds()).toEqual([]);

    await act(async () => held.resolve(jobPage([proJob()])));
    await findRow(proJob().id);
    expect(screen.queryByTestId("your-jobs-loading")).toBeNull();
  });

  it("lists every active job soonest first though the API pages them newest first", async () => {
    const tomorrow = jobN(1, { scheduled_start_at: TOMORROW });
    const later = jobN(2, { scheduled_start_at: TODAY_LATE, status: "on_the_way" });
    const earliest = jobN(3, { scheduled_start_at: TODAY_EARLY });
    const nextWeek = jobN(4, { scheduled_start_at: NEXT_WEEK });
    answer(jobPage([nextWeek, tomorrow], "cursor-2"));
    answer(jobPage([later, earliest]));
    await renderWithQuery(<YourJobs />);

    await findRow(earliest.id);
    expect(rowIds()).toEqual([earliest.id, later.id, tomorrow.id, nextWeek.id]);
    expect(listCalls()).toEqual([
      [
        LIST,
        expect.objectContaining({
          auth: true,
          generation: 1,
          signal: expect.any(AbortSignal),
          query: { active: "true", cursor: undefined },
        }),
      ],
      [
        LIST,
        expect.objectContaining({
          auth: true,
          generation: 1,
          query: { active: "true", cursor: "cursor-2" },
        }),
      ],
    ]);
  });

  it("names each row by its status, day and time, the work, the customer and the city", async () => {
    const today = jobN(1, { scheduled_start_at: TODAY_LATE });
    const tomorrow = jobN(2, { scheduled_start_at: TOMORROW, customer_first_name: null });
    const later = jobN(3, { scheduled_start_at: NEXT_WEEK, address: null, category: null });
    answer(jobPage([later, tomorrow, today]));
    await renderWithQuery(<YourJobs />);
    await findRow(today.id);

    expect(rowLabel(today.id)).toBe(
      `Scheduled. Today, ${timeOf(TODAY_LATE)}. Painting for Maria, Fort Lauderdale.`,
    );
    expect(rowLabel(tomorrow.id)).toBe(
      `Scheduled. Tomorrow, ${timeOf(TOMORROW)}. Painting, Fort Lauderdale.`,
    );
    const day = formatInstantDay(Date.parse(NEXT_WEEK), formatLocale());
    expect(rowLabel(later.id)).toBe(
      `Scheduled. ${day}, ${timeOf(NEXT_WEEK)}. Other request for Maria.`,
    );
    expect(row(today.id).props.accessibilityRole).toBe("button");
  });

  it("shows the time, the status pill, the category and the customer with the city on each row", async () => {
    const scheduled = jobN(1, { scheduled_start_at: TODAY_EARLY });
    const onTheWay = jobN(2, {
      scheduled_start_at: TODAY_LATE,
      status: "on_the_way",
      customer_first_name: null,
    });
    const checkedIn = arrived({ id: jobN(3).id, scheduled_start_at: TOMORROW });
    const started = working({ id: jobN(4).id, scheduled_start_at: NEXT_WEEK });
    answer(jobPage([started, checkedIn, onTheWay, scheduled]));
    await renderWithQuery(<YourJobs />);
    await findRow(scheduled.id);

    const cases: [ProJob, string, string][] = [
      [scheduled, "Scheduled", TODAY_EARLY],
      [onTheWay, "On the way", TODAY_LATE],
      [checkedIn, "Arrived", TOMORROW],
      [started, "Working", NEXT_WEEK],
    ];
    for (const [job, status, at] of cases) {
      expect(line(job.id, "time").props.children).toBe(timeOf(at));
      expect(within(line(job.id, "status")).getByText(status, HIDDEN)).toBeTruthy();
      expect(line(job.id, "category").props.children).toBe("Painting");
    }

    // The name and the city never break apart inside themselves: no-break spaces join them.
    expect(line(scheduled.id, "place").props.children).toBe(`Maria${NBSP}· Fort${NBSP}Lauderdale`);
    // No name to show: the city alone.
    expect(line(onTheWay.id, "place").props.children).toBe(`Fort${NBSP}Lauderdale`);
    expect(within(row(onTheWay.id)).queryByText(/Maria/, HIDDEN)).toBeNull();
    // The lines are for sighted users; the row's label reads them out.
    expect(within(row(scheduled.id)).queryByText("Painting")).toBeNull();
  });

  it("leaves the place line out when the job has neither a name nor a city", async () => {
    const bare = proJob({ customer_first_name: "  ", address: null });
    answer(jobPage([bare]));
    await renderWithQuery(<YourJobs />);
    await findRow(bare.id);

    expect(screen.queryByTestId(`pro-job-${bare.id}-place`, HIDDEN)).toBeNull();
    expect(rowLabel(bare.id)).toMatch(/\. Painting\.$/);
  });

  it("says how a job arrives when the pro has none", async () => {
    answer(jobPage([]));
    await renderWithQuery(<YourJobs />);

    const empty = await screen.findByTestId("your-jobs-empty");
    expect(within(empty).getByText("No jobs on your calendar")).toBeTruthy();
    expect(
      within(empty).getByText(
        "When a customer hires you and pays, the job shows up here with the address and everything you need.",
      ),
    ).toBeTruthy();
    expect(rowIds()).toEqual([]);
    expect(screen.queryByTestId("your-jobs-loading")).toBeNull();
  });

  it("offers Try again after a failure, which asks again and then shows the jobs", async () => {
    jest.mocked(apiGet).mockRejectedValueOnce(new NetworkError(false));
    await renderWithQuery(<YourJobs />);

    expect(await screen.findByText("We couldn't load your jobs.")).toBeTruthy();
    expect(screen.queryByTestId("your-jobs-loading")).toBeNull();
    expect(listCalls()).toHaveLength(1);

    answer(jobPage([proJob()]));
    await press(screen.getByRole("button", { name: "Try again" }));

    await findRow(proJob().id);
    expect(listCalls()).toHaveLength(2);
    expect(screen.queryByText("We couldn't load your jobs.")).toBeNull();
  });

  it("a tap opens the job screen once, even when a second tap lands before the push", async () => {
    const job = proJob();
    answer(jobPage([job]));
    await renderWithQuery(<YourJobs />);
    await findRow(job.id);

    await press(row(job.id));
    await press(row(job.id));
    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith({ pathname: "/jobs/[id]", params: { id: job.id } });

    // The push lands and the pro comes back: the next tap opens it again.
    await act(async () => navigation.setNavigating(true));
    await act(async () => navigation.setNavigating(false));
    await press(row(job.id));
    expect(router.push).toHaveBeenCalledTimes(2);
  });

  it("asks nothing for a customer, not even when the screen comes back into focus", async () => {
    jest.mocked(useSession).mockReturnValue(signedIn({ role: "customer" }));
    await renderWithQuery(<YourJobs />);

    await act(async () => navigation.setFocused(false));
    await act(async () => navigation.setFocused(true));
    await act(settle);
    expect(apiGet).not.toHaveBeenCalled();
    expect(rowIds()).toEqual([]);
  });

  it("asks again when the home comes back into focus and shows the new answer", async () => {
    const first = jobN(1, { scheduled_start_at: TODAY_LATE });
    const added = jobN(2, { scheduled_start_at: TODAY_EARLY });
    answer(jobPage([first]));
    await renderWithQuery(<YourJobs />);
    await findRow(first.id);
    expect(listCalls()).toHaveLength(1);

    answer(jobPage([first, added]));
    await act(async () => navigation.setFocused(false));
    await act(async () => navigation.setFocused(true));

    await findRow(added.id);
    expect(listCalls()).toHaveLength(2);
    expect(rowIds()).toEqual([added.id, first.id]);
  });

  it("asks again when the app returns to the foreground", async () => {
    const job = proJob();
    answer(jobPage([job]));
    await renderWithQuery(<YourJobs />);
    await findRow(job.id);

    answer(jobPage([]));
    const listener = jest.mocked(AppState.addEventListener).mock.calls[0][1] as (
      state: AppStateStatus,
    ) => void;
    await act(async () => listener("active"));

    expect(await screen.findByTestId("your-jobs-empty")).toBeTruthy();
    expect(listCalls()).toHaveLength(2);
  });

  it("never shows the jobs of a session that signed out while they were on the way", async () => {
    const held = deferred<ProJobPage>();
    jest.mocked(apiGet).mockReturnValueOnce(held.promise);
    await renderWithQuery(<YourJobs />);
    await waitFor(() => expect(listCalls()).toHaveLength(1));

    mockSession.generation += 1;
    jest.mocked(useSession).mockReturnValue(SIGNED_OUT_SESSION);
    await screen.rerender(<YourJobs />);

    await act(async () => held.resolve(jobPage([proJob()])));
    await act(settle);
    await act(settle);

    expect(rowIds()).toEqual([]);
    expect(screen.queryByTestId(`pro-job-${proJob().id}`, HIDDEN)).toBeNull();
    expect(listCalls()).toHaveLength(1);
  });

  it("after another pro signs in, the first pro's late answer never replaces the new list", async () => {
    const theirs = jobN(1);
    const mine = jobN(2, { customer_first_name: "Ana" });
    const held = deferred<ProJobPage>();
    jest.mocked(apiGet).mockReturnValueOnce(held.promise);
    await renderWithQuery(<YourJobs />);
    await waitFor(() => expect(listCalls()).toHaveLength(1));

    mockSession.generation += 1;
    jest.mocked(useSession).mockReturnValue(signedIn({ role: "pro", first_name: "Eve" }));
    answer(jobPage([mine]));
    await screen.rerender(<YourJobs />);
    await findRow(mine.id);
    expect(listCalls()[1][1]).toEqual(expect.objectContaining({ generation: 2 }));

    await act(async () => held.resolve(jobPage([theirs])));
    await act(settle);
    await act(settle);

    expect(rowIds()).toEqual([mine.id]);
  });
});
