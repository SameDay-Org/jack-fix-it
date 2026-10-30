import "@/i18n";

import type { QueryClient } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";

import { ApiError, apiGet, NetworkError, useSession } from "@/api";
import { toastStore } from "@/components/ui/toast";

import { deferred } from "../../../api/__tests__/helpers";
import { signedIn } from "../../home/__tests__/helpers";
import { ProHomeScreen } from "../../pro-home/ProHomeScreen";
import {
  flattenOpportunities,
  OPPORTUNITIES_QUERY_KEY,
  type OpportunityPage,
} from "../../pro-home/useOpportunities";
import { OpportunityDetailScreen } from "../OpportunityDetailScreen";
import { opportunityQueryKey } from "../useOpportunity";
import {
  detail,
  DISPATCH_ID,
  freezeClock,
  navigation,
  newQueryClient,
  page,
  renderWithQuery,
  summary,
} from "./helpers";

jest.mock("@/api", () => ({
  ...jest.requireActual("../../../api/errors"),
  apiGet: jest.fn(),
  useSession: jest.fn(),
}));
jest.mock("expo-router", () => jest.requireActual("./helpers").routerMock);
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);

const LIST = "/v1/pros/me/opportunities";
const DETAIL = "/v1/pros/me/opportunities/{dispatch_id}";
const CARD_ID = /^opportunity-[0-9a-f-]{36}$/;
const MORE_FAILED = "We couldn't load more requests.";
const GONE = "This request is no longer available";
// The skeletons and the card lines are hidden from assistive technology.
const HIDDEN = { includeHiddenElements: true };

/** A is the one the detail opens; B and C are unrelated. */
const A = summary(1, { dispatch_id: DISPATCH_ID });
const B = summary(2);
const C = summary(3);
const NOT_FOUND = new ApiError(404, "not_found");

/** What each path answers next, in order. */
type Answer = () => Promise<unknown>;
let answers: Record<string, Answer[]>;
const answer = (path: string, ...next: Answer[]) => answers[path]?.push(...next);
const ok =
  (value: unknown): Answer =>
  () =>
    Promise.resolve(value);
const fail =
  (error: unknown): Answer =>
  () =>
    Promise.reject(error);
const pending =
  (promise: Promise<unknown>): Answer =>
  () =>
    promise;

const cardIds = () =>
  screen.queryAllByTestId(CARD_ID).map((card) => (card.props.testID as string).slice(12));
const cachedIds = (client: QueryClient) =>
  flattenOpportunities(client.getQueryData(OPPORTUNITIES_QUERY_KEY)).map(
    (item) => item.dispatch_id,
  );
const listCursors = () =>
  jest
    .mocked(apiGet)
    .mock.calls.filter(([path]) => path === LIST)
    .map(([, options]) => (options as { query: { cursor?: string } }).query.cursor);
const list = () => screen.getByTestId("opportunity-list");

/** The home, and the detail of A pushed over it when `open`. */
function Pro({ open = false }: { open?: boolean }) {
  return (
    <>
      <ProHomeScreen />
      {open ? <OpportunityDetailScreen /> : null}
    </>
  );
}

/**
 * The Vault's sequence up to the race: page 1 is [A, B], page 2 fails, its retry is pending when
 * A's detail answers 404. Returns the pending page and the rendered tree once the screen shows
 * the denial: the cache changes before the list re-renders (TanStack notifies on a later timer),
 * so the retry stays held until the cards and the footer are observed.
 */
async function denyDuringPendingRetry(client: QueryClient) {
  const retried = deferred<OpportunityPage>();
  answer(
    LIST,
    ok(page([A, B], "cursor-2")),
    fail(new NetworkError(false)),
    pending(retried.promise),
  );
  answer(DETAIL, fail(NOT_FOUND));
  const view = await renderWithQuery(<Pro />, client);
  await screen.findByTestId(`opportunity-${A.dispatch_id}`);

  await fireEvent(list(), "onEndReached");
  expect(await screen.findByText(MORE_FAILED)).toBeTruthy();
  await fireEvent.press(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByTestId("opportunity-list-next-page", HIDDEN)).toBeTruthy();

  await view.rerender(<Pro open />);
  expect(await screen.findByText(GONE)).toBeTruthy();
  await waitFor(() => expect(cachedIds(client)).toEqual([B.dispatch_id]));
  // The skeleton showed until now: the failed-page notice is back only once the cancel renders.
  expect(await screen.findByText(MORE_FAILED)).toBeTruthy();
  await waitFor(() => expect(cardIds()).toEqual([B.dispatch_id]));
  return { retried, view };
}

beforeEach(() => {
  freezeClock();
  navigation.reset();
  answers = { [LIST]: [], [DETAIL]: [] };
  jest.mocked(useSession).mockReturnValue(signedIn({ role: "pro", first_name: "Dan" }));
  jest
    .mocked(apiGet)
    .mockReset()
    .mockImplementation(((path: string) => {
      const next = answers[path]?.shift();
      return next ? next() : Promise.reject(new Error(`no answer queued for ${path}`));
    }) as unknown as typeof apiGet);
  toastStore.getState().current = null;
});

afterEach(() => jest.useRealTimers());

describe("a denied opportunity (404 on its detail)", () => {
  it("pending next-page retry cannot restore a denied row", async () => {
    const client = newQueryClient();
    const unrelated = detail({ dispatch_id: B.dispatch_id, public_code: "JF-000202" });
    client.setQueryData(opportunityQueryKey(B.dispatch_id), unrelated);
    const { retried } = await denyDuringPendingRetry(client);

    await act(async () => retried.resolve(page([C])));

    expect(cachedIds(client)).not.toContain(A.dispatch_id);
    expect(cardIds()).not.toContain(A.dispatch_id);
    expect(client.getQueryData(opportunityQueryKey(A.dispatch_id))).toBeUndefined();
    // Unrelated rows and details are untouched.
    expect(cardIds()).toEqual([B.dispatch_id]);
    expect(client.getQueryData(opportunityQueryKey(B.dispatch_id))).toBe(unrelated);
  });

  it("retry after cancellation fetches the same cursor", async () => {
    const client = newQueryClient();
    const { retried } = await denyDuringPendingRetry(client);

    // The cancelled retry is offered again: no skeleton, no error state, no toast.
    expect(screen.getByText(MORE_FAILED)).toBeTruthy();
    expect(screen.queryByTestId("opportunity-list-next-page", HIDDEN)).toBeNull();
    expect(screen.queryByTestId("opportunity-list-error")).toBeNull();
    expect(toastStore.getState().current).toBeNull();
    // The cancelled fetch landing later changes nothing.
    await act(async () => retried.resolve(page([C])));
    expect(cardIds()).toEqual([B.dispatch_id]);

    answer(LIST, ok(page([C])));
    await fireEvent.press(screen.getByRole("button", { name: "Try again" }));
    await screen.findByTestId(`opportunity-${C.dispatch_id}`);
    expect(listCursors()).toEqual([undefined, "cursor-2", "cursor-2", "cursor-2"]);
    expect(cardIds()).toEqual([B.dispatch_id, C.dispatch_id]);
    expect(screen.queryByText(MORE_FAILED)).toBeNull();
  });

  it("a denial of a request the list does not hold leaves its page fetch alone", async () => {
    const client = newQueryClient();
    const next = deferred<OpportunityPage>();
    answer(LIST, ok(page([B], "cursor-2")), pending(next.promise));
    answer(DETAIL, fail(NOT_FOUND));
    const view = await renderWithQuery(<Pro />, client);
    await screen.findByTestId(`opportunity-${B.dispatch_id}`);
    await fireEvent(list(), "onEndReached");
    expect(await screen.findByTestId("opportunity-list-next-page", HIDDEN)).toBeTruthy();

    // A, opened from a push, was never in the list: the page on its way still lands.
    await view.rerender(<Pro open />);
    expect(await screen.findByText(GONE)).toBeTruthy();
    await act(async () => next.resolve(page([C])));
    await waitFor(() => expect(cardIds()).toEqual([B.dispatch_id, C.dispatch_id]));
    expect(listCursors()).toEqual([undefined, "cursor-2"]);
  });

  it("a later list response containing a denied id does not show it", async () => {
    const client = newQueryClient();
    answer(LIST, ok(page([A, B])));
    answer(DETAIL, fail(NOT_FOUND));
    await renderWithQuery(<Pro open />, client);
    expect(await screen.findByText(GONE)).toBeTruthy();
    await waitFor(() => expect(cardIds()).toEqual([B.dispatch_id]));

    // The server still lists A (its answer was made before A closed).
    answer(LIST, ok(page([A, B, C])));
    await act(() => client.refetchQueries({ queryKey: OPPORTUNITIES_QUERY_KEY, exact: true }));

    expect(cachedIds(client)).toEqual([A.dispatch_id, B.dispatch_id, C.dispatch_id]);
    await waitFor(() => expect(cardIds()).toEqual([B.dispatch_id, C.dispatch_id]));
    expect(screen.queryByTestId(`opportunity-${A.dispatch_id}`, HIDDEN)).toBeNull();
  });

  it("a fresh 200 for the denied detail clears the denial", async () => {
    const client = newQueryClient();
    answer(LIST, ok(page([A, B])));
    answer(DETAIL, fail(NOT_FOUND));
    const view = await renderWithQuery(<Pro open />, client);
    expect(await screen.findByText(GONE)).toBeTruthy();
    await view.rerender(<Pro />);
    answer(LIST, ok(page([A, B])));
    await act(() => client.refetchQueries({ queryKey: OPPORTUNITIES_QUERY_KEY, exact: true }));
    await waitFor(() => expect(cachedIds(client)).toEqual([A.dispatch_id, B.dispatch_id]));
    expect(cardIds()).toEqual([B.dispatch_id]);

    // A later open that fails keeps the denial: no 200 came.
    answer(DETAIL, fail(new NetworkError(false)), ok(detail()));
    await view.rerender(<Pro open />);
    expect(await screen.findByText("We couldn't load this request")).toBeTruthy();
    expect(cardIds()).toEqual([B.dispatch_id]);

    // Its retry answers 200: the request is open for this pro again, and its row comes back.
    await fireEvent.press(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("JF-000124")).toBeTruthy();
    await waitFor(() => expect(cardIds()).toEqual([A.dispatch_id, B.dispatch_id]));
  });

  it("sign-out's cache clear takes the denials with it", async () => {
    const client = newQueryClient();
    answer(LIST, ok(page([A, B])));
    answer(DETAIL, fail(NOT_FOUND));
    const view = await renderWithQuery(<Pro open />, client);
    expect(await screen.findByText(GONE)).toBeTruthy();
    await view.unmount();

    // The session barrier clears the whole cache (`beginSignOut`); the next session starts clean.
    client.clear();
    answer(LIST, ok(page([A, B])));
    await renderWithQuery(<Pro />, client);
    await screen.findByTestId(`opportunity-${A.dispatch_id}`);
    expect(cardIds()).toEqual([A.dispatch_id, B.dispatch_id]);
  });
});
