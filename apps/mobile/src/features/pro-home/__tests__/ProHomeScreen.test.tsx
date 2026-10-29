import "@/i18n";

import { act, fireEvent, screen, waitFor, within } from "@testing-library/react-native";
import { router } from "expo-router";
import {
  AppState,
  RefreshControl,
  type AppStateStatus,
  type RefreshControlProps,
} from "react-native";

import { ApiError, apiGet, NetworkError, useSession, type GetResponse } from "@/api";
import { dismissToast, toastStore } from "@/components/ui/toast";

import { deferred } from "../../../api/__tests__/helpers";
import { signedIn } from "../../home/__tests__/helpers";
import {
  freezeClock,
  navigation,
  page,
  renderWithQuery,
  summary,
} from "../../opportunities/__tests__/helpers";
import { ProHomeScreen } from "../ProHomeScreen";
import { OPPORTUNITY_PAGE_SIZE, type OpportunityPage } from "../useOpportunities";

jest.mock("@/api", () => ({
  ...jest.requireActual("../../../api/errors"),
  apiGet: jest.fn(),
  useSession: jest.fn(),
}));
jest.mock(
  "expo-router",
  () => jest.requireActual("../../opportunities/__tests__/helpers").routerMock,
);
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);

const LIST = "/v1/pros/me/opportunities";
const PROFILE = "/v1/pros/me";
/** The profile the API creates on that first GET; the list never reads it. */
const PROFILE_CREATED = {} as GetResponse<typeof PROFILE>;
const CARD_ID = /^opportunity-[0-9a-f-]{36}$/;
// The card's lines are hidden from assistive technology (its label says it all).
const HIDDEN = { includeHiddenElements: true };

const cardIds = () => screen.queryAllByTestId(CARD_ID).map((card) => card.props.testID as string);
const card = (dispatchId: string) => within(screen.getByTestId(`opportunity-${dispatchId}`));
const calledPaths = () => jest.mocked(apiGet).mock.calls.map(([path]) => path);
const findCard = (dispatchId: string) => screen.findByTestId(`opportunity-${dispatchId}`);

const FRESH = summary(1);
const OPENED = summary(2, {
  viewed: true,
  category: null,
  preferred_date: null,
  location: { zip_code: "33010", city: null },
  sent_at: "2026-10-25T13:00:00Z",
});

function pullToRefresh(): void {
  const mock = RefreshControl as unknown as { latestRef: { props: RefreshControlProps } | null };
  mock.latestRef?.props.onRefresh?.();
}

beforeEach(() => {
  freezeClock();
  navigation.reset();
  jest.mocked(useSession).mockReturnValue(signedIn({ role: "pro", first_name: "Dan" }));
  jest
    .mocked(apiGet)
    .mockReset()
    .mockResolvedValue(page([FRESH, OPENED]));
  jest.mocked(router.push).mockClear();
  toastStore.getState().current = null;
});

afterEach(() => {
  dismissToast(); // a shown toast arms its own dismiss timer
  jest.useRealTimers();
});

describe("ProHomeScreen", () => {
  it("a pro sees the cards in the API's order, each with its lines; New follows viewed", async () => {
    await renderWithQuery(<ProHomeScreen />);

    await findCard(FRESH.dispatch_id);
    expect(cardIds()).toEqual([
      `opportunity-${FRESH.dispatch_id}`,
      `opportunity-${OPENED.dispatch_id}`,
    ]);
    expect(apiGet).toHaveBeenCalledWith(LIST, {
      auth: true,
      signal: expect.any(AbortSignal),
      query: { limit: OPPORTUNITY_PAGE_SIZE, cursor: undefined },
    });

    const fresh = card(FRESH.dispatch_id);
    expect(fresh.getByText("Painting", HIDDEN)).toBeTruthy();
    expect(fresh.getByText("New", HIDDEN)).toBeTruthy();
    expect(fresh.getByText(FRESH.description_excerpt, HIDDEN)).toBeTruthy();
    expect(fresh.getByText("Fort Lauderdale 33301", HIDDEN)).toBeTruthy();
    expect(fresh.getByText("Preferred Fri, Oct 30", HIDDEN)).toBeTruthy();
    expect(fresh.getByText("Sent 2 h ago", HIDDEN)).toBeTruthy();

    const opened = card(OPENED.dispatch_id);
    expect(opened.getByText("Other request", HIDDEN)).toBeTruthy();
    expect(opened.queryByText("New", HIDDEN)).toBeNull();
    expect(opened.getByText("33010", HIDDEN)).toBeTruthy();
    expect(opened.getByText("Sent 3 days ago", HIDDEN)).toBeTruthy();
  });

  it("a tap opens the detail once, even when tapped twice before the push lands", async () => {
    await renderWithQuery(<ProHomeScreen />);
    const pressable = await findCard(FRESH.dispatch_id);

    await fireEvent.press(pressable);
    await act(async () => navigation.setNavigating(true));
    await fireEvent.press(pressable);

    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith({
      pathname: "/opportunities/[id]",
      params: { id: FRESH.dispatch_id },
    });

    // The push landed: the next tap opens again.
    await act(async () => navigation.setNavigating(false));
    await fireEvent.press(pressable);
    expect(router.push).toHaveBeenCalledTimes(2);
  });

  it("shows card-shaped skeletons under the header until the page arrives", async () => {
    const pending = deferred<OpportunityPage>();
    jest.mocked(apiGet).mockReturnValue(pending.promise);
    await renderWithQuery(<ProHomeScreen />);

    expect(screen.getByRole("header", { name: "Hi, Dan" })).toBeTruthy();
    expect(screen.getByRole("header", { name: "New opportunities" })).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Loading opportunities" })).toBeTruthy();
    expect(screen.getAllByTestId(/^opportunity-skeleton-\d$/, HIDDEN)).toHaveLength(3);

    await act(async () => pending.resolve(page([FRESH])));
    await findCard(FRESH.dispatch_id);
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("an empty page shows the empty state, with no promise of a notification", async () => {
    jest.mocked(apiGet).mockResolvedValue(page([]));
    await renderWithQuery(<ProHomeScreen />);

    expect(await screen.findByText("No new requests right now")).toBeTruthy();
    expect(screen.getByTestId("opportunity-list-empty")).toBeTruthy();
    expect(screen.queryByText(/notif/i)).toBeNull();
  });

  it("a network error shows a retry, which fetches again", async () => {
    jest.mocked(apiGet).mockRejectedValueOnce(new NetworkError(false));
    await renderWithQuery(<ProHomeScreen />);

    expect(await screen.findByText("We couldn't load your opportunities")).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "Try again" }));

    await findCard(FRESH.dispatch_id);
    expect(apiGet).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("We couldn't load your opportunities")).toBeNull();
  });

  it("404 not_found creates the profile once, then asks for the page again", async () => {
    jest
      .mocked(apiGet)
      .mockRejectedValueOnce(new ApiError(404, "not_found"))
      .mockResolvedValueOnce(PROFILE_CREATED)
      .mockResolvedValueOnce(page([]));
    await renderWithQuery(<ProHomeScreen />);

    expect(await screen.findByText("No new requests right now")).toBeTruthy();
    expect(calledPaths()).toEqual([LIST, PROFILE, LIST]);
    expect(apiGet).toHaveBeenNthCalledWith(2, PROFILE, expect.objectContaining({ auth: true }));
  });

  it("a profile that cannot be created shows the error state", async () => {
    jest
      .mocked(apiGet)
      .mockRejectedValueOnce(new ApiError(404, "not_found"))
      .mockRejectedValueOnce(new ApiError(503, undefined));
    await renderWithQuery(<ProHomeScreen />);

    expect(await screen.findByText("We couldn't load your opportunities")).toBeTruthy();
    expect(calledPaths()).toEqual([LIST, PROFILE]);
  });

  it("loads the next page on the cursor as the end nears, and appends it", async () => {
    const third = summary(3);
    jest
      .mocked(apiGet)
      .mockResolvedValueOnce(page([FRESH, OPENED], "cursor-2"))
      .mockResolvedValueOnce(page([third]));
    await renderWithQuery(<ProHomeScreen />);
    await findCard(FRESH.dispatch_id);

    await fireEvent(screen.getByTestId("opportunity-list"), "onEndReached");

    await findCard(third.dispatch_id);
    expect(apiGet).toHaveBeenLastCalledWith(LIST, {
      auth: true,
      signal: expect.any(AbortSignal),
      query: { limit: OPPORTUNITY_PAGE_SIZE, cursor: "cursor-2" },
    });
    expect(cardIds()).toEqual([
      `opportunity-${FRESH.dispatch_id}`,
      `opportunity-${OPENED.dispatch_id}`,
      `opportunity-${third.dispatch_id}`,
    ]);

    // The last page: nearing the end asks for nothing more.
    await fireEvent(screen.getByTestId("opportunity-list"), "onEndReached");
    expect(apiGet).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["a network error", new NetworkError(false)],
    ["a 503", new ApiError(503, undefined)],
  ])(
    "a next page that fails with %s keeps the cards and offers a retry of that cursor",
    async (_, error) => {
      const third = summary(3);
      jest
        .mocked(apiGet)
        .mockResolvedValueOnce(page([FRESH, OPENED], "cursor-2"))
        .mockRejectedValueOnce(error)
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce(page([third]));
      await renderWithQuery(<ProHomeScreen />);
      await findCard(FRESH.dispatch_id);
      const loaded = [`opportunity-${FRESH.dispatch_id}`, `opportunity-${OPENED.dispatch_id}`];

      await fireEvent(screen.getByTestId("opportunity-list"), "onEndReached");
      expect(await screen.findByText("We couldn't load more requests.")).toBeTruthy();
      expect(cardIds()).toEqual(loaded);
      expect(screen.queryByTestId("opportunity-list-next-page")).toBeNull();
      // Nearing the end again asks for nothing: the retry is the pro's.
      await fireEvent(screen.getByTestId("opportunity-list"), "onEndReached");
      expect(apiGet).toHaveBeenCalledTimes(2);

      // A retry that fails again says so again, with the cards still there.
      await fireEvent.press(screen.getByRole("button", { name: "Try again" }));
      await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(3));
      expect(await screen.findByText("We couldn't load more requests.")).toBeTruthy();
      expect(cardIds()).toEqual(loaded);

      await fireEvent.press(screen.getByRole("button", { name: "Try again" }));
      await findCard(third.dispatch_id);
      expect(apiGet).toHaveBeenLastCalledWith(LIST, {
        auth: true,
        signal: expect.any(AbortSignal),
        query: { limit: OPPORTUNITY_PAGE_SIZE, cursor: "cursor-2" },
      });
      expect(cardIds()).toEqual([...loaded, `opportunity-${third.dispatch_id}`]);
      expect(screen.queryByText("We couldn't load more requests.")).toBeNull();
      expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    },
  );

  it("refetches on focus, on foreground and on pull; a failed pull keeps the cards and says so", async () => {
    await renderWithQuery(<ProHomeScreen />);
    await findCard(FRESH.dispatch_id);
    expect(apiGet).toHaveBeenCalledTimes(1);

    await act(async () => navigation.setFocused(false));
    await act(async () => navigation.setFocused(true));
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));

    const onChange = jest.mocked(AppState.addEventListener).mock.calls.at(-1)?.[1] as (
      state: AppStateStatus,
    ) => void;
    await act(async () => onChange("background"));
    await act(async () => onChange("active"));
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(3));

    jest.mocked(apiGet).mockRejectedValueOnce(new NetworkError(false));
    await act(async () => pullToRefresh());
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(4));
    expect(screen.getByTestId(`opportunity-${FRESH.dispatch_id}`)).toBeTruthy();
    expect(toastStore.getState().current?.message).toBe(
      "Couldn't refresh. Check your connection and try again.",
    );
  });
});
