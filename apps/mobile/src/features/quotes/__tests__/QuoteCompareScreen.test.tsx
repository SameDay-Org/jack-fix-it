import i18n from "@/i18n";

import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, renderHook, screen, waitFor, within } from "@testing-library/react-native";
import { router } from "expo-router";
import {
  AccessibilityInfo,
  AppState,
  RefreshControl,
  type AppStateStatus,
  type RefreshControlProps,
} from "react-native";

import { ApiError, apiGet, apiPost, NetworkError } from "@/api";
import { dismissToast, toastStore } from "@/components/ui/toast";
import { MY_REQUESTS_QUERY_KEY } from "@/features/history/useMyRequests";

import { deferred } from "../../../api/__tests__/helpers";
import { AcceptQuoteSheet } from "../AcceptQuoteSheet";
import { QuoteCompareScreen } from "../QuoteCompareScreen";
import { useAcceptQuote } from "../useAcceptQuote";
import { quotesQueryKey, type CustomerQuote, type CustomerQuoteList } from "../useRequestQuotes";
import {
  fakeClock,
  freezeClock,
  navigation,
  screenNavigation,
  newQueryClient,
  NOW,
  quote,
  QUOTES,
  renderWithQuery,
  REQUEST_ID,
} from "./helpers";

jest.mock("@/api", () => ({
  ...jest.requireActual("../../../api/errors"),
  apiGet: jest.fn(),
  apiPost: jest.fn(),
}));
jest.mock("expo-router", () => jest.requireActual("./helpers").routerMock);
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);

/** The quote screen with the accept sheet over it while the (mocked) router has it open. */
function App() {
  const sheet = navigation.useSheet();
  return (
    <>
      <QuoteCompareScreen />
      {sheet ? <AcceptQuoteSheet /> : null}
    </>
  );
}

const CARD_ID = /^quote-[0-9a-f-]{36}$/;
const cardIds = () => screen.queryAllByTestId(CARD_ID).map((card) => card.props.testID as string);
const card = (item: CustomerQuote) => within(screen.getByTestId(`quote-${item.id}`));
// The seal hides itself from accessibility, so queries for it opt into hidden elements.
const HIDDEN = { includeHiddenElements: true };
// A verified pro's name, as its Text holds it: the seal's word joiner glues the seal to it.
const sealed = (name: string) => `${name}\u2060`;
const acceptButtons = () => screen.queryAllByRole("button", { name: /^Accept the quote from/ });
const list = (items: CustomerQuote[]): CustomerQuoteList => ({ items });

const [WITHHELD, MARIA, DAN] = QUOTES;

beforeEach(() => {
  freezeClock();
  navigation.reset();
  jest.mocked(apiGet).mockReset().mockResolvedValue(list(QUOTES));
  jest.mocked(apiPost).mockReset();
  jest.mocked(router.push).mockClear();
  jest.mocked(router.back).mockClear();
  screenNavigation.setParams.mockClear();
  jest.mocked(router.dismissTo).mockClear();
  jest.mocked(AccessibilityInfo.announceForAccessibility).mockClear();
});

afterEach(async () => {
  dismissToast();
  jest.useRealTimers();
  await act(() => i18n.changeLanguage("en"));
});

describe("QuoteCompareScreen", () => {
  it("renders the quotes in the API's order with every field", async () => {
    await renderWithQuery(<App />);
    await screen.findByText("$250");

    expect(cardIds()).toEqual(QUOTES.map((item) => `quote-${item.id}`));
    expect(apiGet).toHaveBeenCalledWith("/v1/requests/{request_id}/quotes", {
      auth: true,
      signal: expect.any(AbortSignal),
      params: { request_id: REQUEST_ID },
    });

    const maria = card(MARIA);
    expect(maria.getByText("$250")).toBeTruthy();
    expect(maria.getByText("About 1 h 30 min")).toBeTruthy();
    expect(
      maria.getByText(/^Starts [A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}, \d{1,2}:00\s[AP]M$/),
    ).toBeTruthy();
    // Seen, not read twice: the summary label says it (next test).
    expect(maria.getByText("Expires in 2 h", { includeHiddenElements: true })).toBeTruthy();
    expect(maria.getByText(sealed("María P."))).toBeTruthy();
    expect(maria.getByText("New · 12 jobs · 8 years of experience")).toBeTruthy();
    expect(maria.getByText("What's included")).toBeTruthy();
    expect(maria.getByTestId(`quote-${MARIA.id}-scope`).props.children).toBe(MARIA.scope);
    expect(
      maria.getByRole("button", { name: "Accept the quote from María P. for $250" }),
    ).toBeTruthy();

    expect(card(WITHHELD).getByText("$180.50")).toBeTruthy();
    expect(card(WITHHELD).getByText("About 45 min")).toBeTruthy();
    expect(card(WITHHELD).getByText("★ 4.3 · 3 jobs · 1 year of experience")).toBeTruthy();
    expect(card(DAN).getByText("$120")).toBeTruthy();
    expect(card(DAN).getByText("About 3 h")).toBeTruthy();
    expect(card(DAN).getByText("★ 4.8 · 1 job")).toBeTruthy();
  });

  it("a null name shows the neutral label; a null rating shows New", async () => {
    await renderWithQuery(<App />);
    await screen.findByText("$250");

    expect(card(WITHHELD).getByText(sealed("Jack pro"))).toBeTruthy();
    expect(card(MARIA).getByText(/^New · /)).toBeTruthy();
    expect(card(MARIA).getByLabelText(/, No ratings yet, /)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Accept the quote from Jack pro for $180.50" }),
    ).toBeTruthy();

    await act(() => i18n.changeLanguage("es"));
    expect(card(WITHHELD).getByText(sealed("Profesional de Jack"))).toBeTruthy();
    expect(card(MARIA).getByText(/^Nuevo · 12 trabajos · 8 años de experiencia$/)).toBeTruthy();
  });

  it("QuoteCard shows the seal only for verified pros", async () => {
    await renderWithQuery(<App />);
    await screen.findByText("$250");

    for (const item of [MARIA, WITHHELD]) {
      expect(card(item).getByTestId(`quote-${item.id}-verified`, HIDDEN)).toBeTruthy();
    }
    expect(card(DAN).queryByTestId(`quote-${DAN.id}-verified`, HIDDEN)).toBeNull();
    expect(card(DAN).getByText("Dan K.")).toBeTruthy();
    expect(card(DAN).queryByLabelText(/Verified/)).toBeNull();
    // The seal replaced the text pill: no card shows "Verified" as text, its summary says it.
    expect(screen.queryByText(/Verified/, HIDDEN)).toBeNull();
  });

  it("the seal sits inside the name's line, right after the name", async () => {
    await renderWithQuery(<App />);
    await screen.findByText("$250");

    const seal = screen.getByTestId(`quote-${MARIA.id}-verified`, HIDDEN);
    const name = card(MARIA).getByText(sealed("María P."));
    expect(seal.parent).toBe(name);
    expect(name.props.className).toContain("text-headline");
  });

  it("View profile opens the pro's profile with both ids, named after the pro", async () => {
    await renderWithQuery(<App />);
    await screen.findByText("$250");

    const view = card(MARIA).getByRole("button", { name: "View María P.'s profile" });
    expect(within(view).getByText("View profile")).toBeTruthy();
    await fireEvent.press(view);
    expect(router.push).toHaveBeenCalledWith({
      pathname: "/requests/[id]/quotes/[quoteId]/pro",
      params: { id: REQUEST_ID, quoteId: MARIA.id },
    });
    expect(screen.queryByTestId("accept-quote-sheet")).toBeNull();
    // One push at a time: Accept tapped before the profile landed opens nothing, and works
    // again once the router is idle.
    const accept = card(MARIA).getByRole("button", { name: /^Accept the quote from María/ });
    await fireEvent.press(accept);
    expect(router.push).toHaveBeenCalledTimes(1);
    await act(async () => navigation.setNavigating(true));
    await act(async () => navigation.setNavigating(false));
    await fireEvent.press(accept);
    expect(router.push).toHaveBeenCalledTimes(2);

    // Named as the card names the pro: the neutral label when the API withholds the name.
    expect(card(WITHHELD).getByRole("button", { name: "View Jack pro's profile" })).toBeTruthy();
    await act(() => i18n.changeLanguage("es"));
    expect(card(MARIA).getByRole("button", { name: "Ver el perfil de María P." })).toBeTruthy();
    expect(card(MARIA).getByText("Ver perfil")).toBeTruthy();
  });

  it("a link that landed here with a profile param opens that pro's profile over the list", async () => {
    navigation.setParams({ id: REQUEST_ID, profile: MARIA.id });
    await renderWithQuery(<App />);
    await screen.findByText("$250");

    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith({
      pathname: "/requests/[id]/quotes/[quoteId]/pro",
      params: { id: REQUEST_ID, quoteId: MARIA.id },
    });
    expect(screen.queryByTestId("accept-quote-sheet")).toBeNull();
    // Cleared with the push: a later mount of the comparison opens nothing again.
    expect(screenNavigation.setParams).toHaveBeenCalledWith({ profile: undefined });
  });

  it.each<[string, string | string[]]>([
    ["repeated", [MARIA.id, MARIA.id]],
    ["two ids", [MARIA.id, DAN.id]],
    ["path segments", ["..", "..", "6f1c2a40-0000-4000-8000-000000000999", "quotes", DAN.id]],
    ["a dot segment", ".."],
    ["a path", `../../${MARIA.id}`],
    ["an escape left in", `${MARIA.id}%26profile%3D..`],
    ["a delimiter", `${MARIA.id}&profile=${DAN.id}`],
    ["not a UUID", "123"],
    ["uppercase", MARIA.id.toUpperCase().replace(/0/g, "A")],
    ["empty", ""],
  ])("a link's profile param that is %s is cleared and opens nothing", async (_, profile) => {
    navigation.setParams({ id: REQUEST_ID, profile });
    await renderWithQuery(<App />);
    await screen.findByText("$250");

    expect(screenNavigation.setParams).toHaveBeenCalledTimes(1);
    expect(screenNavigation.setParams).toHaveBeenCalledWith({ profile: undefined });
    expect(router.push).not.toHaveBeenCalled();
    // Only the list was asked for: no profile fetch.
    expect(jest.mocked(apiGet).mock.calls.map(([path]) => path)).toEqual([
      "/v1/requests/{request_id}/quotes",
    ]);
  });

  it("each card reads as one label: pro, verified, price, start and the rest", async () => {
    await renderWithQuery(<App />);
    await screen.findByText("$250");

    const summary = screen.getByTestId(`quote-${MARIA.id}-summary`);
    expect(summary.props.accessible).toBe(true);
    expect(String(summary.props.accessibilityLabel).replaceAll("\u00A0", " ")).toMatch(
      /^María P\., Verified by Jack Fix It, \$250, Starts .+, About 1 h 30 min, No ratings yet, 12 jobs, 8 years of experience, Expires in 2 h$/,
    );
    // The footer's expiry is in that label already: a screen reader does not read it twice.
    expect(screen.queryByText("Expires in 2 h")).toBeNull();
  });

  it("accept asks for confirmation, posts once, ignores double taps and shows the accepted state", async () => {
    const answer = deferred<CustomerQuote>();
    jest.mocked(apiPost).mockReturnValue(answer.promise);
    await renderWithQuery(<App />);
    const accept = await screen.findByRole("button", {
      name: "Accept the quote from Jack pro for $180.50",
    });

    await fireEvent.press(accept);
    await fireEvent.press(accept);
    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith({
      pathname: "/requests/[id]/accept",
      params: { id: REQUEST_ID, quote: WITHHELD.id },
    });
    expect(apiPost).not.toHaveBeenCalled();

    const sheet = within(screen.getByTestId("accept-quote-sheet"));
    expect(sheet.getByText("Accept this quote?")).toBeTruthy();
    expect(sheet.getByText("$180.50")).toBeTruthy();
    expect(sheet.getByLabelText("From Jack pro, verified")).toBeTruthy();

    // Its name starts with what it shows, so voice control finds it by "Accept quote".
    const confirm = sheet.getByRole("button", { name: "Accept quote from Jack pro for $180.50" });
    await fireEvent.press(confirm);
    await fireEvent.press(confirm);
    expect(apiPost).toHaveBeenCalledTimes(1);
    expect(apiPost).toHaveBeenCalledWith(
      "/v1/requests/{request_id}/quotes/{quote_id}/accept",
      undefined,
      { auth: true, params: { request_id: REQUEST_ID, quote_id: WITHHELD.id } },
    );
    await waitFor(() =>
      expect(screen.getByTestId("accept-quote-confirm").props.accessibilityState).toMatchObject({
        busy: true,
      }),
    );

    const accepted = { ...WITHHELD, status: "accepted" as const };
    // The API lists the accepted quote among the others by price (#188).
    jest.mocked(apiGet).mockResolvedValue(list([MARIA, accepted, DAN]));
    await act(async () => answer.resolve(accepted));

    expect(router.back).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("accept-quote-sheet")).toBeNull();
    expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith(
      "Quote accepted. Payment comes next.",
    );
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
    expect(cardIds()).toEqual([WITHHELD, MARIA, DAN].map((item) => `quote-${item.id}`));
    expect(card(WITHHELD).getByText("Accepted")).toBeTruthy();
    expect(
      card(WITHHELD).getByText("Quote accepted. Payment comes next.", {
        includeHiddenElements: true,
      }),
    ).toBeTruthy();
    expect(acceptButtons()).toEqual([]);
  });

  it("an accepted quote on open shows first and no Accept buttons", async () => {
    const accepted = { ...DAN, status: "accepted" as const };
    // Last in the API's answer; first on screen, and the others keep the API's order.
    jest.mocked(apiGet).mockResolvedValue(list([MARIA, WITHHELD, accepted]));
    await renderWithQuery(<App />);
    await screen.findByText("$120");

    expect(cardIds()).toEqual([DAN, MARIA, WITHHELD].map((item) => `quote-${item.id}`));
    expect(card(DAN).getByText("Accepted")).toBeTruthy();
    expect(
      card(DAN).getByText("Quote accepted. Payment comes next.", { includeHiddenElements: true }),
    ).toBeTruthy();
    expect(screen.getByTestId(`quote-${DAN.id}-summary`).props.accessibilityLabel).toMatch(
      /, Quote accepted\. Payment comes next\.$/,
    );
    // The pending quotes stay listed, with their expiry, and nothing to accept.
    expect(
      card(MARIA).getByTestId(`quote-${MARIA.id}-expiry`, { includeHiddenElements: true }),
    ).toBeTruthy();
    expect(acceptButtons()).toEqual([]);
  });

  /**
   * Confirms María's quote, lands a refresh with `refreshed` while the POST is in flight (null:
   * no refresh, her quote stays cached), then answers 200 while the follow-up GET fails. The 200
   * is the word on the list: her quote is first, accepted, and nothing else can be accepted.
   */
  async function acceptWhileRefreshed(refreshed: CustomerQuote[] | null): Promise<void> {
    const client = newQueryClient();
    const answer = deferred<CustomerQuote>();
    jest.mocked(apiPost).mockReturnValue(answer.promise);
    await renderWithQuery(<App />, client);
    await fireEvent.press(
      await screen.findByRole("button", { name: "Accept the quote from María P. for $250" }),
    );
    await fireEvent.press(screen.getByTestId("accept-quote-confirm"));
    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));

    if (refreshed) {
      // A pull from before the sheet lands now, read at the expiry boundary: her row is gone.
      jest.mocked(apiGet).mockResolvedValueOnce(list(refreshed));
      await act(async () => pullToRefresh());
      await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
      expect(screen.queryByTestId(`quote-${MARIA.id}`)).toBeNull();
    }
    const fetches = jest.mocked(apiGet).mock.calls.length;

    jest.mocked(apiGet).mockRejectedValue(new NetworkError(false)); // the follow-up GET fails
    await act(async () => answer.resolve({ ...MARIA, status: "accepted" }));

    expect(router.back).toHaveBeenCalledTimes(1);
    expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith(
      "Quote accepted. Payment comes next.",
    );
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(fetches + 1));
    await waitFor(() =>
      expect(client.getQueryState(quotesQueryKey(REQUEST_ID))?.status).toBe("error"),
    );

    const others = refreshed ?? QUOTES.filter((item) => item.id !== MARIA.id);
    expect(cardIds()).toEqual([MARIA, ...others].map((item) => `quote-${item.id}`));
    expect(card(MARIA).getByText("Accepted")).toBeTruthy();
    expect(acceptButtons()).toEqual([]);
    expect(screen.queryByTestId("quote-list-error")).toBeNull();
    expect(screen.queryByText("Accept this quote?")).toBeNull();
    expect(toastStore.getState().current).toBeNull();
  }

  it.each([
    ["another pending quote", [DAN]],
    ["nothing", []],
  ])(
    "upserts the accepted quote when the cache lost it and holds %s; the failed refetch keeps it",
    async (_, refreshed) => acceptWhileRefreshed(refreshed),
  );

  it("keeps the accepted quote first with no Accept buttons when the refetch fails", async () =>
    acceptWhileRefreshed(null));

  it("a 200 with nothing cached still caches the accepted quote", async () => {
    const accepted = { ...MARIA, status: "accepted" as const };
    jest.mocked(apiPost).mockResolvedValue(accepted);
    jest.mocked(apiGet).mockRejectedValue(new NetworkError(false));
    const client = newQueryClient();
    const { result } = await renderHook(() => useAcceptQuote(REQUEST_ID), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });
    const onDone = jest.fn();

    await act(async () => result.current.accept(MARIA.id, onDone));

    await waitFor(() => expect(onDone).toHaveBeenCalledWith("accepted"));
    expect(client.getQueryData(quotesQueryKey(REQUEST_ID))).toEqual(list([accepted]));
  });

  it.each([
    ["accepted", () => jest.mocked(apiPost).mockResolvedValue({ ...MARIA, status: "accepted" })],
    [
      "notAcceptable",
      () => jest.mocked(apiPost).mockRejectedValue(new ApiError(409, "quote_not_acceptable")),
    ],
  ] as const)(
    "an accept that ends %s marks History's list stale, so its row shows the new status",
    async (outcome, answerWith) => {
      answerWith();
      jest.mocked(apiGet).mockRejectedValue(new NetworkError(false));
      const client = newQueryClient();
      client.setQueryData(MY_REQUESTS_QUERY_KEY, { pages: [], pageParams: [] });
      const { result } = await renderHook(() => useAcceptQuote(REQUEST_ID), {
        wrapper: ({ children }) => (
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        ),
      });
      const onDone = jest.fn();
      expect(client.getQueryState(MY_REQUESTS_QUERY_KEY)?.isInvalidated).toBe(false);

      await act(async () => result.current.accept(MARIA.id, onDone));

      await waitFor(() => expect(onDone).toHaveBeenCalledWith(outcome));
      expect(client.getQueryState(MY_REQUESTS_QUERY_KEY)?.isInvalidated).toBe(true);
    },
  );

  it("cancelling the confirmation releases the guard, so Accept opens it again", async () => {
    await renderWithQuery(<App />);
    const accept = () =>
      screen.getByRole("button", { name: "Accept the quote from María P. for $250" });
    await screen.findByText("$250");

    // The push is queued: the router is busy until the sheet lands and the list stays tappable.
    await fireEvent.press(accept());
    await act(async () => navigation.setNavigating(true));
    await fireEvent.press(accept());
    expect(router.push).toHaveBeenCalledTimes(1);
    await act(async () => navigation.setNavigating(false)); // the sheet is up

    // Cancel is a transition too; once it lands the list is on top again.
    await fireEvent.press(screen.getByTestId("accept-quote-cancel"));
    await act(async () => navigation.setNavigating(true));
    expect(screen.queryByTestId("accept-quote-sheet")).toBeNull();
    await act(async () => navigation.setNavigating(false));

    await fireEvent.press(accept());
    expect(router.push).toHaveBeenCalledTimes(2);
    expect(router.push).toHaveBeenLastCalledWith({
      pathname: "/requests/[id]/accept",
      params: { id: REQUEST_ID, quote: MARIA.id },
    });
    expect(screen.getByTestId("accept-quote-sheet")).toBeTruthy();
    expect(apiPost).not.toHaveBeenCalled();
  });

  it.each([
    ["en", "From María P., verified"],
    ["es", "De María P., verificado"],
  ])(
    "AcceptQuoteSheet shows the seal after a verified pro's name (%s)",
    async (language, label) => {
      await act(() => i18n.changeLanguage(language));
      await renderWithQuery(<App />);
      await fireEvent.press(await screen.findByTestId(`quote-${MARIA.id}-accept`));

      const sheet = within(screen.getByTestId("accept-quote-sheet"));
      const line = sheet.getByTestId("accept-quote-pro");
      // One element, read once: the line's label says "verified" and the seal is hidden.
      expect(sheet.getByLabelText(label)).toBe(line);
      expect(sheet.getByTestId("accept-quote-verified", HIDDEN).parent).toBe(line);
      expect(sheet.queryByTestId("accept-quote-verified")).toBeNull();
      expect(sheet.queryByText(/Verified|Verificado/, HIDDEN)).toBeNull();
    },
  );

  it("AcceptQuoteSheet shows no seal for an unverified pro", async () => {
    await renderWithQuery(<App />);
    await fireEvent.press(await screen.findByTestId(`quote-${DAN.id}-accept`));

    const sheet = within(screen.getByTestId("accept-quote-sheet"));
    const line = sheet.getByTestId("accept-quote-pro");
    // Read as shown: no label of its own, so no "verified" either.
    expect(sheet.getByText("From Dan K.")).toBe(line);
    expect(line.props.accessibilityLabel).toBeUndefined();
    expect(sheet.queryByTestId("accept-quote-verified", HIDDEN)).toBeNull();
  });

  it("409 shows the not-acceptable message and refetches", async () => {
    jest.mocked(apiPost).mockRejectedValue(new ApiError(409, "quote_not_acceptable"));
    await renderWithQuery(<App />);
    await fireEvent.press(
      await screen.findByRole("button", { name: "Accept the quote from María P. for $250" }),
    );
    jest.mocked(apiGet).mockResolvedValue(list([WITHHELD, DAN]));

    await fireEvent.press(screen.getByTestId("accept-quote-confirm"));

    await waitFor(() => expect(screen.queryByTestId("accept-quote-sheet")).toBeNull());
    expect(toastStore.getState().current).toMatchObject({
      message: "This quote can't be accepted anymore.",
      tone: "danger",
    });
    await waitFor(() =>
      expect(cardIds()).toEqual([WITHHELD, DAN].map((item) => `quote-${item.id}`)),
    );
    expect(apiGet).toHaveBeenCalledTimes(2);
  });

  it("a failed accept keeps the sheet with the reason, and confirming again posts again", async () => {
    jest
      .mocked(apiPost)
      .mockRejectedValueOnce(new NetworkError(false))
      .mockResolvedValueOnce({ ...MARIA, status: "accepted" });
    await renderWithQuery(<App />);
    await fireEvent.press(
      await screen.findByRole("button", { name: "Accept the quote from María P. for $250" }),
    );

    await fireEvent.press(screen.getByTestId("accept-quote-confirm"));
    expect(
      await screen.findByText("We couldn't accept the quote. Check your connection and try again."),
    ).toBeTruthy();
    expect(router.back).not.toHaveBeenCalled();
    // Said aloud on iOS too, and shown once: in the sheet, not as a toast as well.
    expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith(
      "We couldn't accept the quote. Check your connection and try again.",
    );
    expect(toastStore.getState().current).toBeNull();

    await fireEvent.press(screen.getByTestId("accept-quote-confirm"));
    await waitFor(() => expect(router.back).toHaveBeenCalledTimes(1));
    expect(apiPost).toHaveBeenCalledTimes(2);
  });

  it("an answer that lands after the sheet was swiped away is still told", async () => {
    const answer = deferred<CustomerQuote>();
    jest.mocked(apiPost).mockReturnValue(answer.promise);
    await renderWithQuery(<App />);
    await fireEvent.press(
      await screen.findByRole("button", { name: "Accept the quote from María P. for $250" }),
    );
    await fireEvent.press(screen.getByTestId("accept-quote-confirm"));
    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));

    await act(async () => router.back()); // swiped down while the accept is in flight
    expect(screen.queryByTestId("accept-quote-sheet")).toBeNull();
    await act(async () => answer.reject(new ApiError(409, "quote_not_acceptable")));

    await waitFor(() =>
      expect(toastStore.getState().current?.message).toBe("This quote can't be accepted anymore."),
    );
    expect(router.back).toHaveBeenCalledTimes(1); // the swipe only: nothing closed the list
  });

  it("a network failure after the sheet was swiped away becomes a toast", async () => {
    const answer = deferred<CustomerQuote>();
    jest.mocked(apiPost).mockReturnValue(answer.promise);
    await renderWithQuery(<App />);
    await fireEvent.press(
      await screen.findByRole("button", { name: "Accept the quote from María P. for $250" }),
    );
    await fireEvent.press(screen.getByTestId("accept-quote-confirm"));
    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));

    await act(async () => router.back());
    await act(async () => answer.reject(new NetworkError(false)));

    await waitFor(() =>
      expect(toastStore.getState().current).toMatchObject({
        message: "We couldn't accept the quote. Check your connection and try again.",
        tone: "danger",
      }),
    );
    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it("404 shows not found; network error shows retry", async () => {
    jest.mocked(apiGet).mockRejectedValue(new ApiError(404, "not_found"));
    const { unmount } = await renderWithQuery(<App />);

    expect(await screen.findByRole("header", { name: "Request not found" })).toBeTruthy();
    // A request that is not found stays so: coming back to the screen asks nothing again.
    await act(async () => navigation.setFocused(false));
    await act(async () => navigation.setFocused(true));
    expect(apiGet).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("header", { name: "Request not found" })).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "Go to home" }));
    expect(router.dismissTo).toHaveBeenCalledWith("/");
    await unmount();

    jest.mocked(apiGet).mockReset().mockRejectedValueOnce(new NetworkError(true));
    await renderWithQuery(<App />);
    expect(await screen.findByRole("header", { name: "We couldn't load the quotes" })).toBeTruthy();
    expect(screen.queryByRole("header", { name: "Request not found" })).toBeNull();

    const retried = deferred<CustomerQuoteList>();
    jest.mocked(apiGet).mockReturnValue(retried.promise);
    await fireEvent.press(screen.getByRole("button", { name: "Try again" }));
    // The error card stays while the retry runs, its button busy; no skeletons in between.
    await waitFor(() =>
      expect(screen.getByTestId("quote-list-error-action").props.accessibilityState).toMatchObject({
        busy: true,
      }),
    );
    expect(screen.queryByRole("progressbar", { name: "Loading quotes" })).toBeNull();
    await act(async () => retried.resolve(list(QUOTES)));
    expect(await screen.findByText("$250")).toBeTruthy();
    expect(apiGet).toHaveBeenCalledTimes(2);
  });

  it("empty list shows the waiting state", async () => {
    jest.mocked(apiGet).mockResolvedValue(list([]));
    await renderWithQuery(<App />);

    expect(await screen.findByRole("header", { name: "No quotes yet" })).toBeTruthy();
    expect(
      screen.getByText(
        "Quotes from pros show up here as they arrive. Pull down to check for new ones.",
      ),
    ).toBeTruthy();
    expect(screen.queryAllByRole("button", { name: /Try again|Go to home/ })).toEqual([]);
  });

  it("refetches on pull, on focus and on app foreground", async () => {
    await renderWithQuery(<App />);
    await screen.findByText("$250");
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
    // The quotes stay; a toast says the pull failed.
    expect(screen.getByText("$250")).toBeTruthy();
    expect(toastStore.getState().current?.message).toBe(
      "Couldn't refresh. Check your connection and try again.",
    );
  });

  it("a quote that expires while open loses its Accept button", async () => {
    fakeClock();
    const soon = quote(4, {
      amount_cents: 9_900,
      expires_at: new Date(NOW + 90_000).toISOString(),
      pro: { name: "Ana R." },
    });
    jest.mocked(apiGet).mockResolvedValue(list([soon, MARIA]));
    await renderWithQuery(<App />);
    await screen.findByText("$99");

    const ana = () => screen.getByTestId(`quote-${soon.id}`);
    expect(
      within(ana()).getByText("Expires in 2 min", { includeHiddenElements: true }),
    ).toBeTruthy();
    await act(async () => jest.advanceTimersByTime(30_000));
    expect(
      within(ana()).getByText("Expires in 1 min", { includeHiddenElements: true }),
    ).toBeTruthy();
    expect(acceptButtons()).toHaveLength(2);

    // One act per label change, as on the device: each timer is armed after the render before it.
    await act(async () => jest.advanceTimersByTime(30_000)); // María's countdown ticks
    await act(async () => jest.advanceTimersByTime(30_000)); // Ana's quote expires
    expect(within(ana()).getByText("Expired", { includeHiddenElements: true })).toBeTruthy();
    expect(within(ana()).queryByRole("button", { name: /^Accept/ })).toBeNull();
    expect(screen.getByTestId(`quote-${soon.id}-summary`).props.accessibilityLabel).toMatch(
      /, Expired$/,
    );
    expect(acceptButtons()).toHaveLength(1);
    expect(apiGet).toHaveBeenCalledTimes(1); // no reload needed
  });

  it("loading skeletons occupy the loaded layout's space", async () => {
    const pending = deferred<CustomerQuoteList>();
    jest.mocked(apiGet).mockReturnValue(pending.promise);
    await renderWithQuery(<App />);

    // The title is in place from the first frame; the quotes arrive under it.
    expect(screen.getByRole("header", { name: "Your quotes" })).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Loading quotes" })).toBeTruthy();
    const skeletons = screen.getAllByTestId(/^quote-skeleton-\d$/, { includeHiddenElements: true });
    expect(skeletons).toHaveLength(2);

    // A verified pro, like every quote the list endpoint returns (it lists approved pros only).
    await act(async () => pending.resolve(list([MARIA])));
    await screen.findByText("$250");
    expect(screen.queryByRole("progressbar")).toBeNull();

    // Row for row, the placeholder lines are the loaded card's text styles (a two-line scope).
    // The verified seal sits inside the name's line, so neither has a badge row.
    const loaded = lineStyles(screen.getByTestId(`quote-${MARIA.id}`)).flatMap((style) =>
      style === "scope" ? ["text-callout", "text-callout"] : [style],
    );
    expect(lineStyles(skeletons[0])).toEqual(loaded);
  });

  it("a long scope shows four lines and a More control that expands it", async () => {
    await renderWithQuery(<App />);
    await screen.findByText("$250");
    const scope = () => screen.getByTestId(`quote-${MARIA.id}-scope`);
    const measure = screen.getByTestId(`quote-${MARIA.id}-scope-measure`, {
      includeHiddenElements: true,
    });
    expect(scope().props.numberOfLines).toBe(4);

    await fireEvent(measure, "textLayout", { nativeEvent: { lines: Array(4).fill({}) } });
    expect(screen.queryByRole("button", { name: /^More/ })).toBeNull();

    await fireEvent(measure, "textLayout", { nativeEvent: { lines: Array(6).fill({}) } });
    await fireEvent.press(
      screen.getByRole("button", { name: "More, show all of what's included" }),
    );
    expect(scope().props.numberOfLines).toBe(0);
    await fireEvent.press(
      screen.getByRole("button", { name: "Less, show less of what's included" }),
    );
    expect(scope().props.numberOfLines).toBe(4);
  });
});

type HostNode = {
  type: unknown;
  props: Record<string, unknown>;
  children: readonly (HostNode | string)[];
};

/** Pulls the list down: RN's Jest mock of RefreshControl keeps its latest instance. */
function pullToRefresh(): void {
  const mock = RefreshControl as unknown as { latestRef: { props: RefreshControlProps } | null };
  mock.latestRef?.props.onRefresh?.();
}

const TYPE_STYLE = /\btext-(?:display|title-1|title-2|headline|body|callout|footnote|caption)\b/;

/** Spacing that shapes a card's height: padding and minimum height always, a gap between 2+ children. */
const PADDING = /(?:^|\s)(p[ytb]?-\d+|min-h-\d+)(?=\s|$)/g;
const GAP = /(?:^|\s)(gap(?:-y)?-\d+)(?=\s|$)/g;

/**
 * The rows of a card, top to bottom: each line of text by its type style, and each box's vertical
 * spacing, leaving out what a placeholder does not stand for: button labels, the accepted badge
 * and the scope's hidden measuring copy. The View profile ghost is one 48 dp row; the visible
 * scope is reported as "scope", since its line count comes from layout.
 */
function lineStyles(root: unknown): string[] {
  const styles: string[] = [];
  const walk = (node: HostNode | string) => {
    if (typeof node === "string") return;
    const testID = String(node.props.testID ?? "");
    const className = String(node.props.className ?? "");
    if (testID.endsWith("-profile")) {
      // The View profile ghost (a button) and its placeholder: the same 48 dp row, pulled in the
      // same way.
      const pulled = /(?:^|\s)-my-3(?=\s|$)/.test(className) && /\bmin-h-12\b/.test(className);
      styles.push(`profile:${pulled ? "-my-3 min-h-12" : "?"}`);
      return;
    }
    if (node.props.accessibilityRole === "button") return;
    if (testID.endsWith("-measure") || testID.endsWith("-accepted")) return;
    if (node.type === "Text") {
      styles.push(testID.endsWith("-scope") ? "scope" : (TYPE_STYLE.exec(className)?.[0] ?? "?"));
      return;
    }
    const boxed = [...className.matchAll(PADDING)].map((match) => match[1]);
    if (node.children.filter((child) => typeof child !== "string").length > 1) {
      boxed.push(...[...className.matchAll(GAP)].map((match) => match[1]));
    }
    if (boxed.length > 0) styles.push(`box:${boxed.join(" ")}`);
    node.children.forEach(walk);
  };
  walk(root as HostNode);
  return styles;
}
