import i18n from "@/i18n";

import { act, fireEvent, screen, waitFor, within } from "@testing-library/react-native";
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

import { deferred } from "../../../api/__tests__/helpers";
import { AcceptQuoteSheet } from "../AcceptQuoteSheet";
import { QuoteCompareScreen } from "../QuoteCompareScreen";
import type { CustomerQuote, CustomerQuoteList } from "../useRequestQuotes";
import { fakeClock, freezeClock, navigation, NOW, quote, QUOTES, renderWithQuery } from "./helpers";

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
const acceptButtons = () => screen.queryAllByRole("button", { name: /^Accept the quote from/ });
const list = (items: CustomerQuote[]): CustomerQuoteList => ({ items });

const [MARIA, WITHHELD, DAN] = QUOTES;

beforeEach(() => {
  freezeClock();
  navigation.reset();
  jest.mocked(apiGet).mockReset().mockResolvedValue(list(QUOTES));
  jest.mocked(apiPost).mockReset();
  jest.mocked(router.push).mockClear();
  jest.mocked(router.back).mockClear();
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
      params: { request_id: MARIA.pro && expect.any(String) },
    });

    const maria = card(MARIA);
    expect(maria.getByText("$250")).toBeTruthy();
    expect(maria.getByText("About 1 h 30 min")).toBeTruthy();
    expect(
      maria.getByText(/^Starts [A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}, \d{1,2}:00\s[AP]M$/),
    ).toBeTruthy();
    // Seen, not read twice: the summary label says it (next test).
    expect(maria.getByText("Expires in 6 h", { includeHiddenElements: true })).toBeTruthy();
    expect(maria.getByText("María P.")).toBeTruthy();
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

    expect(card(WITHHELD).getByText("Jack pro")).toBeTruthy();
    expect(card(MARIA).getByText(/^New · /)).toBeTruthy();
    expect(card(MARIA).getByLabelText(/, No ratings yet, /)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Accept the quote from Jack pro for $180.50" }),
    ).toBeTruthy();

    await act(() => i18n.changeLanguage("es"));
    expect(card(WITHHELD).getByText("Profesional de Jack")).toBeTruthy();
    expect(card(MARIA).getByText(/^Nuevo · 12 trabajos · 8 años de experiencia$/)).toBeTruthy();
  });

  it("the verified badge shows only when verified", async () => {
    await renderWithQuery(<App />);
    await screen.findByText("$250");

    expect(card(MARIA).getByText("Verified by Jack Fix It")).toBeTruthy();
    expect(card(WITHHELD).getByText("Verified by Jack Fix It")).toBeTruthy();
    expect(card(DAN).queryByText("Verified by Jack Fix It")).toBeNull();
    expect(card(DAN).queryByLabelText(/Verified/)).toBeNull();
  });

  it("each card reads as one label: pro, verified, price, start and the rest", async () => {
    await renderWithQuery(<App />);
    await screen.findByText("$250");

    const summary = screen.getByTestId(`quote-${MARIA.id}-summary`);
    expect(summary.props.accessible).toBe(true);
    expect(summary.props.accessibilityLabel).toMatch(
      /^María P\., Verified by Jack Fix It, \$250, Starts .+, About 1 h 30 min, No ratings yet, 12 jobs, 8 years of experience, Expires in 6 h$/,
    );
    // The footer's expiry is in that label already: a screen reader does not read it twice.
    expect(screen.queryByText("Expires in 6 h")).toBeNull();
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
      params: { id: expect.any(String), quote: WITHHELD.id },
    });
    expect(apiPost).not.toHaveBeenCalled();

    const sheet = within(screen.getByTestId("accept-quote-sheet"));
    expect(sheet.getByText("Accept this quote?")).toBeTruthy();
    expect(sheet.getByText("$180.50")).toBeTruthy();
    expect(sheet.getByText("From Jack pro")).toBeTruthy();

    const confirm = sheet.getByRole("button", {
      name: "Accept the quote from Jack pro for $180.50",
    });
    await fireEvent.press(confirm);
    await fireEvent.press(confirm);
    expect(apiPost).toHaveBeenCalledTimes(1);
    expect(apiPost).toHaveBeenCalledWith(
      "/v1/requests/{request_id}/quotes/{quote_id}/accept",
      undefined,
      { auth: true, params: { request_id: expect.any(String), quote_id: WITHHELD.id } },
    );
    await waitFor(() =>
      expect(screen.getByTestId("accept-quote-confirm").props.accessibilityState).toMatchObject({
        busy: true,
      }),
    );

    const accepted = { ...WITHHELD, status: "accepted" as const };
    jest.mocked(apiGet).mockResolvedValue(list([accepted, MARIA, DAN]));
    await act(async () => answer.resolve(accepted));

    expect(router.back).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("accept-quote-sheet")).toBeNull();
    expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith(
      "Quote accepted. Payment comes next.",
    );
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
    expect(cardIds()[0]).toBe(`quote-${WITHHELD.id}`);
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
    jest.mocked(apiGet).mockResolvedValue(list([accepted, MARIA, WITHHELD]));
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
    expect(within(ana()).queryByRole("button")).toBeNull();
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

    // Row for row, the placeholder lines are the loaded card's text styles (a two-line scope),
    // the verified badge's row included.
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
    expect(screen.queryByRole("button", { name: "Show all of what's included" })).toBeNull();

    await fireEvent(measure, "textLayout", { nativeEvent: { lines: Array(6).fill({}) } });
    await fireEvent.press(screen.getByRole("button", { name: "Show all of what's included" }));
    expect(scope().props.numberOfLines).toBe(0);
    await fireEvent.press(screen.getByRole("button", { name: "Show less of what's included" }));
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

/**
 * The type style of each line of text in a card, top to bottom, leaving out what a placeholder
 * does not stand for: button labels, the accepted badge and the scope's hidden measuring copy.
 * The verified badge is one padded row; the visible scope is reported as "scope", since its line
 * count comes from layout.
 */
function lineStyles(root: unknown): string[] {
  const styles: string[] = [];
  const walk = (node: HostNode | string) => {
    if (typeof node === "string" || node.props.accessibilityRole === "button") return;
    const testID = String(node.props.testID ?? "");
    if (testID.endsWith("-measure") || testID.endsWith("-accepted")) return;
    if (testID.endsWith("-verified") || testID.endsWith("-badge")) {
      // The badge and its placeholder: the same vertical padding around one caption line.
      const padded = /py-1/.test(String(node.props.className));
      const inner = node.children.flatMap((child) => lineStyles(child)).join("+");
      styles.push(`badge:${padded ? "py-1" : "?"}:${inner}`);
      return;
    }
    if (node.type === "Text") {
      styles.push(
        testID.endsWith("-scope")
          ? "scope"
          : (TYPE_STYLE.exec(String(node.props.className))?.[0] ?? "?"),
      );
      return;
    }
    node.children.forEach(walk);
  };
  walk(root as HostNode);
  return styles;
}
