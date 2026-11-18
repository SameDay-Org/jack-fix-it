import "@/i18n";

import { act, fireEvent, screen, waitFor, within } from "@testing-library/react-native";
import { router } from "expo-router";
import { RefreshControl, type RefreshControlProps } from "react-native";

import { ApiError, apiGet, NetworkError, useSession } from "@/api";
import { dismissToast, toastStore } from "@/components/ui/toast";

import { deferred } from "../../../api/__tests__/helpers";
import { FULL_PROFILE } from "../../pro-profile/__tests__/helpers";
import { EarningsScreen } from "../EarningsScreen";
import {
  AWAITING,
  earning,
  earningsCursors,
  earningsPage,
  freezeClock,
  jobId,
  navigation,
  ON_HOLD,
  ON_THE_WAY,
  renderWithQuery,
  routeApi,
  signedIn,
  ZERO,
} from "./helpers";

jest.mock("@/api", () => jest.requireActual("./helpers").apiMock());
jest.mock("expo-router", () => jest.requireActual("./helpers").routerMock);
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);
// Reduce Motion on: the skeletons' endless pulse would otherwise keep the run busy.
jest.mock("react-native-reanimated", () => ({
  __esModule: true,
  ...jest.requireActual<typeof import("react-native-reanimated")>("react-native-reanimated"),
  useReducedMotion: jest.fn(() => true),
}));

const HIDDEN = { includeHiddenElements: true };
const ROW_ID = /^earning-[0-9a-f-]{36}$/;
const rowIds = () => screen.queryAllByTestId(ROW_ID).map((row) => row.props.testID as string);
const mockApiGet = jest.mocked(apiGet);

let payoutsEnabled = true;
const profile = () => Promise.resolve({ ...FULL_PROFILE, payouts_enabled: payoutsEnabled });
/** The earnings answers, by cursor: a page, or an error to throw. */
let answers: Map<string | undefined, unknown>;
const earnings = (cursor: string | undefined) => {
  const answer = answers.get(cursor);
  return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
};

function pullToRefresh(): void {
  const mock = RefreshControl as unknown as { latestRef: { props: RefreshControlProps } | null };
  mock.latestRef?.props.onRefresh?.();
}

const nearEnd = () => fireEvent(screen.getByTestId("earnings-list"), "onEndReached");

beforeEach(() => {
  freezeClock();
  navigation.reset();
  payoutsEnabled = true;
  answers = new Map([[undefined, earningsPage([earning(1), ON_THE_WAY, AWAITING, ON_HOLD])]]);
  jest.mocked(useSession).mockReturnValue(signedIn({ role: "pro" }));
  mockApiGet.mockReset();
  routeApi(mockApiGet, earnings, profile);
  jest.mocked(router.push).mockClear();
  toastStore.getState().current = null;
});

afterEach(() => {
  dismissToast();
  jest.useRealTimers();
});

describe("EarningsScreen", () => {
  it("shows the summary's shape with its labels while loading, never a bare spinner", async () => {
    const first = deferred<unknown>();
    answers.set(undefined, undefined);
    routeApi(mockApiGet, () => first.promise, profile);
    await renderWithQuery(<EarningsScreen />);

    const loading = screen.getByTestId("earnings-summary-loading");
    expect(loading.props.accessibilityLabel).toBe("Loading your earnings");
    expect(within(loading).getByText("Awaiting customer confirmation", HIDDEN)).toBeTruthy();
    expect(screen.getByTestId("earnings-rows-loading", HIDDEN)).toBeTruthy();

    await act(async () => first.resolve(earningsPage([earning(1)])));
    expect(await screen.findByTestId("earnings-summary")).toBeTruthy();
    expect(screen.queryByTestId("earnings-rows-loading", HIDDEN)).toBeNull();
  });

  it("the four totals are the API's summary, each read as one with its line", async () => {
    await renderWithQuery(<EarningsScreen />);
    await screen.findByTestId("earnings-summary");

    // None of these is the sum of the rows on screen ($120.00, $90.50, $45.00, $25.00 apart).
    expect(screen.getByLabelText("Paid, $1,540.00. Sent to your payout account.")).toBeTruthy();
    expect(
      screen.getByLabelText(
        "On its way, $90.50. Confirmed by the customer. Your payment is on its way.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByLabelText(
        "Awaiting customer confirmation, $45.00. Jobs you finished that the customer hasn't confirmed yet.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByLabelText("Under review, $25.00. Our team is looking at these jobs."),
    ).toBeTruthy();
    expect(screen.getByTestId("earnings-figure-paid-amount", HIDDEN)).toHaveTextContent(
      "$1,540.00",
    );
  });

  it("each row: what the job was, the amount, a worded chip and its date; no customer field", async () => {
    // A field the contract does not have (a customer's name) is never drawn.
    const extra = { ...earning(1), customer_name: "SENTINEL Customer" } as ReturnType<
      typeof earning
    >;
    answers.set(undefined, earningsPage([extra, ON_THE_WAY, AWAITING, ON_HOLD]));
    await renderWithQuery(<EarningsScreen />);
    await screen.findByTestId(`earning-${jobId(1)}`);

    expect(rowIds()).toEqual([1, 2, 3, 4].map((n) => `earning-${jobId(n)}`));
    for (const label of [
      "House cleaning, $120.00, Paid, Paid on Nov 12",
      "Plumbing, $90.50, On its way, Completed Nov 10",
      "House cleaning, $45.00, Awaiting confirmation, Completed Nov 10, Usually confirmed by Nov 15",
      "House cleaning, $25.00, Under review, Completed Nov 10",
    ]) {
      expect(screen.getByLabelText(label)).toBeTruthy();
    }
    const onHold = within(screen.getByTestId(`earning-${jobId(4)}-status`));
    expect(onHold.getByText(/Under review/, HIDDEN)).toBeTruthy();
    expect(screen.queryByText(/SENTINEL/, HIDDEN)).toBeNull();
  });

  it("loads the next page on the cursor as the end nears and appends it, each job once", async () => {
    answers.set(undefined, earningsPage([earning(1), ON_THE_WAY], "c1"));
    answers.set("c1", earningsPage([ON_THE_WAY, AWAITING], "c2"));
    answers.set("c2", earningsPage([ON_HOLD]));
    await renderWithQuery(<EarningsScreen />);
    await screen.findByTestId(`earning-${jobId(2)}`);

    await act(async () => nearEnd());
    await screen.findByTestId(`earning-${jobId(3)}`);
    await act(async () => nearEnd());
    await screen.findByTestId(`earning-${jobId(4)}`);
    expect(earningsCursors(mockApiGet)).toEqual([undefined, "c1", "c2"]);
    expect(rowIds()).toEqual([1, 2, 3, 4].map((n) => `earning-${jobId(n)}`));

    // The last page has no cursor: nothing more is asked for.
    await act(async () => nearEnd());
    expect(earningsCursors(mockApiGet)).toHaveLength(3);
  });

  it("a pull asks again from the first page and keeps each job once", async () => {
    answers.set(undefined, earningsPage([earning(1)], "c1"));
    answers.set("c1", earningsPage([ON_THE_WAY]));
    await renderWithQuery(<EarningsScreen />);
    await screen.findByTestId(`earning-${jobId(1)}`);
    await act(async () => nearEnd());
    await screen.findByTestId(`earning-${jobId(2)}`);

    answers.set(undefined, earningsPage([AWAITING, earning(1)], "c1"));
    await act(async () => pullToRefresh());
    await screen.findByTestId(`earning-${jobId(3)}`);
    expect(earningsCursors(mockApiGet)).toEqual([undefined, "c1", undefined, "c1"]);
    expect(rowIds()).toEqual([3, 1, 2].map((n) => `earning-${jobId(n)}`));
  });

  it("a next page that fails keeps the rows and retries that cursor", async () => {
    answers.set(undefined, earningsPage([earning(1)], "c1"));
    answers.set("c1", new NetworkError(false));
    await renderWithQuery(<EarningsScreen />);
    await screen.findByTestId(`earning-${jobId(1)}`);

    await act(async () => nearEnd());
    expect(await screen.findByText("More jobs didn't load.")).toBeTruthy();
    expect(rowIds()).toEqual([`earning-${jobId(1)}`]);
    // A failed page is not asked for again on every scroll: the retry is the pro's.
    await act(async () => nearEnd());
    expect(earningsCursors(mockApiGet)).toEqual([undefined, "c1"]);

    answers.set("c1", earningsPage([ON_THE_WAY]));
    await fireEvent.press(screen.getByTestId("earnings-next-page-error-action"));
    await screen.findByTestId(`earning-${jobId(2)}`);
    expect(earningsCursors(mockApiGet)).toEqual([undefined, "c1", "c1"]);
    expect(screen.queryByTestId("earnings-next-page-error")).toBeNull();
  });

  it("before any finished job, says where earnings will show", async () => {
    answers.set(undefined, earningsPage([], null, ZERO));
    await renderWithQuery(<EarningsScreen />);

    expect(await screen.findByTestId("earnings-empty")).toBeTruthy();
    expect(
      screen.getByText("Your earnings will show here after your first finished job."),
    ).toBeTruthy();
    expect(screen.queryByText("Jobs")).toBeNull();
    // Four $0.00 totals would push the message below the fold: the empty state stands alone.
    expect(screen.queryByTestId("earnings-summary")).toBeNull();
  });

  it.each([
    ["offline", new NetworkError(false), "You're offline"],
    ["busy", new ApiError(429, "rate_limited"), "Give it a moment"],
    ["generic", new ApiError(500, "internal_error"), "Your earnings didn't load"],
  ] as const)("%s: a calm state with a retry, never the API's words", async (key, error, title) => {
    answers.set(undefined, error);
    await renderWithQuery(<EarningsScreen />);

    const state = await screen.findByTestId(`earnings-error-${key}`);
    expect(within(state).getByText(title)).toBeTruthy();
    expect(screen.queryByText(/rate_limited|internal_error|status/)).toBeNull();
    expect(screen.queryByTestId("earnings-summary")).toBeNull();

    answers.set(undefined, earningsPage([earning(1)]));
    await fireEvent.press(within(state).getByTestId(`earnings-error-${key}-action`));
    expect(await screen.findByTestId(`earning-${jobId(1)}`)).toBeTruthy();
  });

  it("a pull that fails over the rows keeps them and says why", async () => {
    await renderWithQuery(<EarningsScreen />);
    await screen.findByTestId(`earning-${jobId(1)}`);

    answers.set(undefined, new ApiError(429, "rate_limited"));
    await act(async () => pullToRefresh());
    await waitFor(() =>
      expect(toastStore.getState().current?.message).toBe(
        "Give it a moment, then pull to refresh again.",
      ),
    );
    expect(rowIds()).toHaveLength(4);
  });

  it("asks again when the screen comes back into focus", async () => {
    await renderWithQuery(<EarningsScreen />);
    await screen.findByTestId(`earning-${jobId(1)}`);
    answers.set(undefined, earningsPage([earning(5), earning(1)]));
    await act(async () => navigation.setFocused(false));
    await act(async () => navigation.setFocused(true));
    await screen.findByTestId(`earning-${jobId(5)}`);
    expect(earningsCursors(mockApiGet)).toEqual([undefined, undefined]);
  });

  it("points a pro whose payouts are off to the setup", async () => {
    payoutsEnabled = false;
    await renderWithQuery(<EarningsScreen />);

    const nudge = await screen.findByTestId("earnings-payouts");
    expect(within(nudge).getByText("Set up payouts to get paid")).toBeTruthy();
    await fireEvent.press(within(nudge).getByTestId("earnings-payouts-action"));
    expect(router.push).toHaveBeenCalledWith("/pro/payouts");
  });

  it("says nothing about payouts once they are on", async () => {
    await renderWithQuery(<EarningsScreen />);
    await screen.findByTestId(`earning-${jobId(1)}`);
    await waitFor(() => expect(mockApiGet).toHaveBeenCalledWith("/v1/pros/me", expect.anything()));
    expect(screen.queryByTestId("earnings-payouts")).toBeNull();
  });
});
