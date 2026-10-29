import i18n from "@/i18n";

import { act, fireEvent, screen, waitFor, within } from "@testing-library/react-native";
import { router } from "expo-router";
import {
  AppState,
  RefreshControl,
  StyleSheet,
  type AppStateStatus,
  type RefreshControlProps,
} from "react-native";

import { apiGet, NetworkError, useSession, type GetResponse } from "@/api";
import { dismissToast, toastStore } from "@/components/ui/toast";

import { deferred } from "../../../api/__tests__/helpers";
import { CATEGORIES, signedIn } from "../../home/__tests__/helpers";
import {
  freezeClock,
  navigation,
  NOW,
  newQueryClient,
  renderWithQuery,
} from "../../opportunities/__tests__/helpers";
import { HistoryScreen } from "../HistoryScreen";
import {
  invalidateMyRequests,
  MY_REQUESTS_PAGE_SIZE,
  type RequestPage,
  type RequestSummary,
} from "../useMyRequests";

jest.mock("@/api", () => ({
  ...jest.requireActual("../../../api/errors"),
  apiGet: jest.fn(),
  useSession: jest.fn(),
}));
jest.mock("expo-router", () => {
  const { routerMock } = jest.requireActual("../../opportunities/__tests__/helpers");
  return {
    ...routerMock,
    router: { ...routerMock.router, navigate: jest.fn() },
    useScrollToTop: jest.fn(),
  };
});
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);

const LIST = "/v1/requests";
const CATALOG = "/v1/categories";
// The row's lines are hidden from assistive technology (its label says it all).
const HIDDEN = { includeHiddenElements: true };
const ROW_ID = /^request-[0-9a-f-]{36}$/;

const [, HANDYMAN, PAINTING] = CATEGORIES;

// Days are the device's: fixtures are set on the local calendar around the frozen NOW
// (2026-10-28 14:00 UTC), so "Today" and "Yesterday" hold in every time zone.
const TODAY = new Date(NOW);
const localDay = (offset: number, hour: number) =>
  new Date(TODAY.getFullYear(), TODAY.getMonth(), TODAY.getDate() + offset, hour);
/** Three days back, as the row writes it ("Oct 25" where NOW falls on Oct 28). */
const THREE_DAYS_AGO = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(
  localDay(-3, 9),
);

/** One of the caller's requests, sent this morning. */
const request = (n: number, overrides: Partial<RequestSummary> = {}): RequestSummary => ({
  id: `00000000-0000-4000-8000-0000000004${String(n).padStart(2, "0")}`,
  public_code: `JF-0001${String(n).padStart(2, "0")}`,
  status: "quote_ready",
  customer_status: "customerStatus.quoteReady",
  category_id: HANDYMAN?.id ?? null,
  created_at: localDay(0, 9).toISOString(),
  media_count: 2,
  ...overrides,
});
const page = (items: RequestSummary[], next_cursor: string | null = null): RequestPage => ({
  items,
  next_cursor,
});

const NEWEST = request(1);
const OLDER = request(2, {
  status: "finding_pro",
  customer_status: "customerStatus.findingAPro",
  category_id: PAINTING?.id ?? null,
  created_at: localDay(-1, 15).toISOString(),
});
const OLDEST = request(3, {
  status: "cancelled",
  customer_status: "customerStatus.cancelled",
  category_id: null,
  created_at: localDay(-3, 9).toISOString(),
});

type Catalog = GetResponse<typeof CATALOG>;
type Answer<T> = T | Promise<T> | Error;
/** What each path answers, in order; the last answer repeats. */
let answers: { list: Answer<RequestPage>[]; catalog: Answer<Catalog>[] };

function answer<T>(queue: Answer<T>[]): Promise<T> {
  const next = queue.length > 1 ? queue.shift() : queue[0];
  if (next instanceof Error) return Promise.reject(next);
  return Promise.resolve(next as T | Promise<T>);
}

const listCalls = () => jest.mocked(apiGet).mock.calls.filter(([path]) => path === LIST);
const rowIds = () => screen.queryAllByTestId(ROW_ID).map((row) => row.props.testID as string);
const rowOf = (item: RequestSummary) => `request-${item.id}`;
const findRow = (item: RequestSummary) => screen.findByTestId(rowOf(item));
const row = (item: RequestSummary) => within(screen.getByTestId(rowOf(item)));

type Node = ReturnType<typeof screen.getByTestId>;
const TYPE_STYLE = /text-(display|title-1|title-2|headline|body|callout|footnote|caption)/;
/** The type style of each text line in a row (or its placeholder), top to bottom. */
const typeStyles = (node: Node) =>
  node
    .queryAll((child) => child.type === "Text" && typeof child.props.className === "string")
    .map((text) => TYPE_STYLE.exec(text.props.className as string)?.[1]);

function pullToRefresh(): void {
  const mock = RefreshControl as unknown as { latestRef: { props: RefreshControlProps } | null };
  mock.latestRef?.props.onRefresh?.();
}

const signedInAs = (role: "customer" | "pro" | "agent", id?: string) =>
  jest.mocked(useSession).mockReturnValue(signedIn({ role, ...(id ? { id } : {}) }));
const signedOut = () =>
  jest.mocked(useSession).mockReturnValue({ ...signedIn(), status: "signedOut", user: null });

beforeEach(() => {
  freezeClock();
  navigation.reset();
  signedInAs("customer");
  answers = { list: [page([NEWEST, OLDER, OLDEST])], catalog: [CATEGORIES] };
  jest
    .mocked(apiGet)
    .mockReset()
    .mockImplementation(((path: string) =>
      path === LIST ? answer(answers.list) : answer(answers.catalog)) as unknown as typeof apiGet);
  toastStore.getState().current = null;
});

afterEach(async () => {
  dismissToast(); // a shown toast arms its own dismiss timer
  jest.clearAllMocks();
  jest.useRealTimers();
  await act(() => i18n.changeLanguage("en"));
});

describe("HistoryScreen, customer: the requests (#47)", () => {
  it("lists the requests newest first: category, code, day and status, each row one label", async () => {
    await renderWithQuery(<HistoryScreen />);

    expect(screen.getByRole("header", { name: "Your requests" })).toBeTruthy();
    await findRow(NEWEST);
    expect(rowIds()).toEqual([rowOf(NEWEST), rowOf(OLDER), rowOf(OLDEST)]);
    expect(apiGet).toHaveBeenCalledWith(LIST, {
      auth: true,
      signal: expect.any(AbortSignal),
      query: { limit: MY_REQUESTS_PAGE_SIZE, cursor: undefined },
    });

    expect(row(NEWEST).getByText("Handyman", HIDDEN)).toBeTruthy();
    expect(row(NEWEST).getByText("JF-000101 · Today", HIDDEN)).toBeTruthy();
    expect(row(NEWEST).getByText("Quote Ready", HIDDEN)).toBeTruthy();
    expect(row(OLDER).getByText("Painting", HIDDEN)).toBeTruthy();
    expect(row(OLDER).getByText("JF-000102 · Yesterday", HIDDEN)).toBeTruthy();
    expect(row(OLDER).getByText("Finding a Pro", HIDDEN)).toBeTruthy();
    // Filed without a category: named "Request".
    expect(row(OLDEST).getByText("Request", HIDDEN)).toBeTruthy();
    expect(row(OLDEST).getByText(`JF-000103 · ${THREE_DAYS_AGO}`, HIDDEN)).toBeTruthy();

    // One element per row for a screen reader, in the order the row is read.
    expect(screen.getByRole("button", { name: "Handyman, JF-000101, Quote Ready, Today" })).toBe(
      screen.getByTestId(rowOf(NEWEST)),
    );
    expect(
      screen.getByRole("button", { name: `Request, JF-000103, Cancelled, ${THREE_DAYS_AGO}` }),
    ).toBe(screen.getByTestId(rowOf(OLDEST)));
    // A calm list, not cards: no raised white bubble (the kit's Card shadow) anywhere.
    const shadowed = screen
      .getByTestId("history-screen")
      .queryAll((node) => StyleSheet.flatten(node.props.style)?.shadowRadius !== undefined);
    expect(shadowed).toEqual([]);
  });

  it("Spanish: the title, the status copy and the days", async () => {
    await act(() => i18n.changeLanguage("es"));
    await renderWithQuery(<HistoryScreen />);

    expect(screen.getByRole("header", { name: "Tus solicitudes" })).toBeTruthy();
    await findRow(NEWEST);
    expect(row(NEWEST).getByText("Reparaciones generales", HIDDEN)).toBeTruthy();
    expect(row(NEWEST).getByText("Presupuesto listo", HIDDEN)).toBeTruthy();
    expect(row(OLDER).getByText("Buscando un profesional", HIDDEN)).toBeTruthy();
    expect(row(OLDER).getByText("JF-000102 · Ayer", HIDDEN)).toBeTruthy();
    expect(row(OLDEST).getByText("Solicitud", HIDDEN)).toBeTruthy();
    // The status agrees with "solicitud".
    expect(row(OLDEST).getByText("Cancelada", HIDDEN)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Pintura, JF-000102, Buscando un profesional, Ayer" }),
    ).toBeTruthy();
  });

  it("a tap opens the request once, even when tapped twice before the push lands", async () => {
    await renderWithQuery(<HistoryScreen />);
    const pressable = await findRow(OLDER);

    await fireEvent.press(pressable);
    await act(async () => navigation.setNavigating(true));
    await fireEvent.press(pressable);

    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith({
      pathname: "/requests/[id]",
      params: { id: OLDER.id },
    });

    await act(async () => navigation.setNavigating(false));
    await fireEvent.press(pressable);
    expect(router.push).toHaveBeenCalledTimes(2);
  });

  it("shows row-shaped skeletons under the title until the rows arrive, line for line", async () => {
    const pending = deferred<RequestPage>();
    answers.list = [pending.promise];
    await renderWithQuery(<HistoryScreen />);

    expect(screen.getByRole("header", { name: "Your requests" })).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Loading your requests" })).toBeTruthy();
    const skeletons = screen.getAllByTestId(/^request-skeleton-\d$/, HIDDEN);
    expect(skeletons).toHaveLength(6);
    // The same lines as a row, in the same type styles (the name, the code and day, the chip's
    // caption), each sized by the same text: the rows take the skeleton's place without a jump.
    const LINES = ["headline", "footnote", "caption"];
    expect(typeStyles(skeletons[0]!)).toEqual(LINES);
    expect(screen.queryByTestId("history-empty")).toBeNull();

    await act(async () => pending.resolve(page([NEWEST])));
    const loaded = await findRow(NEWEST);
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(typeStyles(loaded)).toEqual(LINES);
  });

  it.each([
    ["en", "Handyman"],
    ["es", "Pintura"],
  ])(
    "%s: the skeleton keeps one line for the name, a one-word name of the seed",
    async (lang, name) => {
      await act(() => i18n.changeLanguage(lang));
      answers.list = [deferred<RequestPage>().promise];
      await renderWithQuery(<HistoryScreen />);

      // "Reparaciones generales" wraps at a large font: a sample of it made every one-line row
      // shrink when the rows came in. Only the names that wrap grow their row now.
      const skeleton = within(screen.getByTestId("request-skeleton-0-category", HIDDEN));
      expect(skeleton.getByText(name, HIDDEN)).toBeTruthy();
    },
  );

  it("rows wait for the category catalog, so a row never shows without its name", async () => {
    const catalog = deferred<Catalog>();
    answers.catalog = [catalog.promise];
    await renderWithQuery(<HistoryScreen />);

    await waitFor(() => expect(listCalls()).toHaveLength(1));
    expect(screen.getByRole("progressbar", { name: "Loading your requests" })).toBeTruthy();
    expect(rowIds()).toEqual([]);

    await act(async () => catalog.resolve(CATEGORIES));
    await findRow(NEWEST);
  });

  it("no requests yet: today's empty state, its copy and its way to Home", async () => {
    answers.list = [page([])];
    await renderWithQuery(<HistoryScreen />);

    expect(await screen.findByTestId("history-empty")).toBeTruthy();
    expect(screen.getByText("Requests you send will show up here.")).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "Browse categories" }));
    expect(router.navigate).toHaveBeenCalledWith("/");
  });

  it.each(["list", "catalog"] as const)(
    "a first page that fails (the %s) shows the error on the whole screen; Retry asks again",
    async (failing) => {
      if (failing === "list") answers.list.unshift(new NetworkError(false));
      else answers.catalog.unshift(new NetworkError(false));
      await renderWithQuery(<HistoryScreen />);

      expect(
        await screen.findByRole("header", { name: "We couldn't load your requests" }),
      ).toBeTruthy();
      expect(screen.getByText("Check your connection and try again.")).toBeTruthy();
      expect(screen.queryByTestId("history-empty")).toBeNull();
      expect(rowIds()).toEqual([]);

      await fireEvent.press(screen.getByRole("button", { name: "Try again" }));
      await findRow(NEWEST);
      expect(screen.queryByText("We couldn't load your requests")).toBeNull();
      // Only what was missing is asked for again.
      const paths = jest.mocked(apiGet).mock.calls.map(([path]) => path);
      expect(paths.filter((path) => path === LIST)).toHaveLength(failing === "list" ? 2 : 1);
      expect(paths.filter((path) => path === CATALOG)).toHaveLength(failing === "catalog" ? 2 : 1);
    },
  );

  it("a catalog that fails over no requests still shows the empty state: no row needs it", async () => {
    answers.list = [page([])];
    answers.catalog = [new NetworkError(false)];
    await renderWithQuery(<HistoryScreen />);

    expect(await screen.findByTestId("history-empty")).toBeTruthy();
    expect(screen.queryByText("We couldn't load your requests")).toBeNull();
  });

  it("a pull over a failed catalog asks for it again, and the rows show", async () => {
    answers.catalog = [new NetworkError(false), CATEGORIES];
    await renderWithQuery(<HistoryScreen />);
    expect(
      await screen.findByRole("header", { name: "We couldn't load your requests" }),
    ).toBeTruthy();

    await act(async () => pullToRefresh());

    await findRow(NEWEST);
    expect(jest.mocked(apiGet).mock.calls.filter(([path]) => path === CATALOG)).toHaveLength(2);
  });

  it("loads the next page on the cursor as the end nears, with no row twice", async () => {
    const fourth = request(4, { created_at: localDay(-8, 9).toISOString() });
    // A row on both pages (a page boundary that repeated) shows once.
    answers.list = [page([NEWEST, OLDER], "cursor-2"), page([OLDER, OLDEST, fourth])];
    await renderWithQuery(<HistoryScreen />);
    await findRow(NEWEST);

    await fireEvent(screen.getByTestId("request-list"), "onEndReached");

    await findRow(fourth);
    expect(apiGet).toHaveBeenLastCalledWith(LIST, {
      auth: true,
      signal: expect.any(AbortSignal),
      query: { limit: MY_REQUESTS_PAGE_SIZE, cursor: "cursor-2" },
    });
    expect(rowIds()).toEqual([rowOf(NEWEST), rowOf(OLDER), rowOf(OLDEST), rowOf(fourth)]);

    // The last page: nearing the end asks for nothing more.
    await fireEvent(screen.getByTestId("request-list"), "onEndReached");
    expect(listCalls()).toHaveLength(2);
  });

  it("a next page that fails keeps the rows and offers a retry of that cursor", async () => {
    const failed = new NetworkError(false);
    answers.list = [page([NEWEST, OLDER], "cursor-2"), failed, failed, page([OLDEST])];
    await renderWithQuery(<HistoryScreen />);
    await findRow(NEWEST);
    const loaded = [rowOf(NEWEST), rowOf(OLDER)];

    await fireEvent(screen.getByTestId("request-list"), "onEndReached");
    expect(await screen.findByText("We couldn't load more requests.")).toBeTruthy();
    expect(rowIds()).toEqual(loaded);
    // Nearing the end again asks for nothing: the retry is the customer's.
    await fireEvent(screen.getByTestId("request-list"), "onEndReached");
    expect(listCalls()).toHaveLength(2);

    await fireEvent.press(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(listCalls()).toHaveLength(3));
    expect(await screen.findByText("We couldn't load more requests.")).toBeTruthy();
    expect(rowIds()).toEqual(loaded);

    await fireEvent.press(screen.getByRole("button", { name: "Try again" }));
    await findRow(OLDEST);
    expect(apiGet).toHaveBeenLastCalledWith(LIST, {
      auth: true,
      signal: expect.any(AbortSignal),
      query: { limit: MY_REQUESTS_PAGE_SIZE, cursor: "cursor-2" },
    });
    expect(rowIds()).toEqual([...loaded, rowOf(OLDEST)]);
    expect(screen.queryByText("We couldn't load more requests.")).toBeNull();
  });

  it("nearing the end during a refresh waits for it: the new statuses stay, then the next page loads", async () => {
    const client = newQueryClient();
    const refreshed = deferred<RequestPage>();
    answers.list = [page([NEWEST, OLDER], "cursor-2"), refreshed.promise, page([OLDEST])];
    await renderWithQuery(<HistoryScreen />, client);
    await findRow(NEWEST);

    // A quote accepted elsewhere: the list refreshes and its first page is held.
    await act(async () => void invalidateMyRequests(client));
    await waitFor(() => expect(listCalls()).toHaveLength(2));
    await fireEvent(screen.getByTestId("request-list"), "onEndReached");
    expect(listCalls()).toHaveLength(2);

    await act(async () =>
      refreshed.resolve(
        page([{ ...NEWEST, customer_status: "customerStatus.cancelled" }, OLDER], "cursor-2"),
      ),
    );
    await waitFor(() => expect(row(NEWEST).getByText("Cancelled", HIDDEN)).toBeTruthy());
    await findRow(OLDEST);
    expect(apiGet).toHaveBeenLastCalledWith(LIST, {
      auth: true,
      signal: expect.any(AbortSignal),
      query: { limit: MY_REQUESTS_PAGE_SIZE, cursor: "cursor-2" },
    });
    expect(listCalls()).toHaveLength(3);
    expect(row(NEWEST).getByText("Cancelled", HIDDEN)).toBeTruthy();
  });

  it("refetches on focus, on foreground and on pull; a failed pull keeps the rows and says so", async () => {
    await renderWithQuery(<HistoryScreen />);
    await findRow(NEWEST);
    expect(listCalls()).toHaveLength(1);

    // Back from the request (an accept there) or from another tab.
    await act(async () => navigation.setFocused(false));
    await act(async () => navigation.setFocused(true));
    await waitFor(() => expect(listCalls()).toHaveLength(2));

    const onChange = jest.mocked(AppState.addEventListener).mock.calls.at(-1)?.[1] as (
      state: AppStateStatus,
    ) => void;
    await act(async () => onChange("background"));
    await act(async () => onChange("active"));
    await waitFor(() => expect(listCalls()).toHaveLength(3));

    // A pull shows what changed: a new status on the newest request.
    answers.list = [page([{ ...NEWEST, customer_status: "customerStatus.cancelled" }])];
    await act(async () => pullToRefresh());
    await waitFor(() => expect(row(NEWEST).getByText("Cancelled", HIDDEN)).toBeTruthy());

    answers.list = [new NetworkError(false)];
    await act(async () => pullToRefresh());
    await waitFor(() => expect(listCalls()).toHaveLength(5));
    expect(screen.getByTestId(rowOf(NEWEST))).toBeTruthy();
    expect(toastStore.getState().current?.message).toBe(
      "Couldn't refresh. Check your connection and try again.",
    );
  });

  it("sign-out clears the list with the cache: the next customer never sees the last one's rows", async () => {
    const client = newQueryClient();
    signedInAs("customer", "00000000-0000-4000-8000-00000000000a");
    const view = await renderWithQuery(<HistoryScreen />, client);
    await findRow(NEWEST);

    // The sign-out barrier (src/api/session.ts beginSignOut): signed out, the cache cleared.
    signedOut();
    await act(async () => client.clear());
    await view.rerender(<HistoryScreen />);
    expect(screen.queryByTestId("history-screen")).toBeNull();

    const theirs = request(9, { public_code: "JF-000999" });
    const pending = deferred<RequestPage>();
    answers.list = [pending.promise];
    signedInAs("customer", "00000000-0000-4000-8000-00000000000b");
    await view.rerender(<HistoryScreen />);

    expect(screen.getByRole("progressbar", { name: "Loading your requests" })).toBeTruthy();
    expect(rowIds()).toEqual([]);
    await act(async () => pending.resolve(page([theirs])));
    await findRow(theirs);
    expect(rowIds()).toEqual([rowOf(theirs)]);
  });
});

describe("HistoryScreen, pro and staff: unchanged until their jobs land", () => {
  it("pro: the jobs copy and the way to Home, as one screen; no request list asked for", async () => {
    signedInAs("pro");
    await renderWithQuery(<HistoryScreen />);

    expect(screen.getByRole("header", { name: "Your jobs" })).toBeTruthy();
    expect(screen.getByText("Jobs you're hired for will show up here.")).toBeTruthy();
    const shadowed = screen
      .getByTestId("history-screen")
      .queryAll((node) => StyleSheet.flatten(node.props.style)?.shadowRadius !== undefined);
    expect(shadowed).toEqual([]);
    await fireEvent.press(screen.getByRole("button", { name: "Go to Home" }));
    expect(router.navigate).toHaveBeenCalledWith("/");
    expect(apiGet).not.toHaveBeenCalled();
  });

  it("staff read the pro copy", async () => {
    signedInAs("agent");
    await renderWithQuery(<HistoryScreen />);

    expect(screen.getByRole("header", { name: "Your jobs" })).toBeTruthy();
    expect(apiGet).not.toHaveBeenCalled();
  });

  it("Spanish", async () => {
    signedInAs("pro");
    await act(() => i18n.changeLanguage("es"));
    await renderWithQuery(<HistoryScreen />);

    expect(screen.getByRole("header", { name: "Tus trabajos" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ir a Inicio" })).toBeTruthy();
  });

  it("renders nothing without a user", async () => {
    signedOut();
    await renderWithQuery(<HistoryScreen />);

    expect(screen.queryByTestId("history-screen")).toBeNull();
  });
});
