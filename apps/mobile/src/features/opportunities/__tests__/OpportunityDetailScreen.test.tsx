import "@/i18n";

import type { QueryClient } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react-native";
import { router } from "expo-router";

import { ApiError, apiGet, NetworkError } from "@/api";

import { flattenOpportunities, OPPORTUNITIES_QUERY_KEY } from "../../pro-home/useOpportunities";
import { OpportunityDetailScreen } from "../OpportunityDetailScreen";
import { opportunityQueryKey } from "../useOpportunity";
import {
  detail,
  DISPATCH_ID,
  fakeClock,
  freezeClock,
  mediaItem,
  minutesFromNow,
  navigation,
  newQueryClient,
  page,
  renderWithQuery,
  summary,
  VIDEO,
} from "./helpers";

jest.mock("@/api", () => ({
  ...jest.requireActual("../../../api/errors"),
  apiGet: jest.fn(),
}));
jest.mock("expo-router", () => jest.requireActual("./helpers").routerMock);
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);

const DETAIL = "/v1/pros/me/opportunities/{dispatch_id}";
const HIDDEN = { includeHiddenElements: true };
const MINUTE_MS = 60_000;

const image = (index: number) => screen.queryByTestId(`opportunity-media-${index}-image`, HIDDEN);
const frames = () => screen.queryAllByTestId("media-frame", HIDDEN);

/** One act per minute: the clock re-arms its timer in an effect, which runs between acts. */
async function advanceMinutes(minutes: number): Promise<void> {
  for (let step = 0; step < minutes; step += 1) {
    await act(async () => jest.advanceTimersByTime(MINUTE_MS));
  }
  await act(async () => jest.advanceTimersByTime(1000));
}

/** The list behind the detail: this opportunity, unopened, and another one. */
function seededClient(): QueryClient {
  const client = newQueryClient();
  client.setQueryData(OPPORTUNITIES_QUERY_KEY, {
    pages: [page([summary(1, { dispatch_id: DISPATCH_ID }), summary(2)])],
    pageParams: [undefined],
  });
  return client;
}

const cachedList = (client: QueryClient) =>
  flattenOpportunities(client.getQueryData(OPPORTUNITIES_QUERY_KEY));

/** The same detail with URLs good for 20 more minutes: what a refetch brings back. */
const FRESH = detail({
  media: [
    mediaItem(1, {
      url: "https://media.test.invalid/m/1.jpg?sig=fresh",
      expires_at: minutesFromNow(20),
    }),
    mediaItem(2, {
      url: "https://media.test.invalid/m/2.jpg?sig=fresh",
      expires_at: minutesFromNow(20),
    }),
    {
      ...VIDEO,
      url: "https://media.test.invalid/m/3.mp4?sig=fresh",
      expires_at: minutesFromNow(20),
    },
  ],
});

beforeEach(() => {
  freezeClock();
  navigation.reset();
  jest.mocked(apiGet).mockReset().mockResolvedValue(detail());
  jest.mocked(router.back).mockClear();
  jest.mocked(router.push).mockClear();
  jest.mocked(router.replace).mockClear();
  jest.mocked(router.dismissTo).mockClear();
});

afterEach(() => jest.useRealTimers());

describe("OpportunityDetailScreen", () => {
  it("renders every field and the media, and clears the list's New marker", async () => {
    const client = seededClient();
    await renderWithQuery(<OpportunityDetailScreen />, client);

    expect(await screen.findByText("JF-000124")).toBeTruthy();
    expect(apiGet).toHaveBeenCalledWith(DETAIL, {
      auth: true,
      signal: expect.any(AbortSignal),
      params: { dispatch_id: DISPATCH_ID },
    });
    expect(screen.getByRole("header", { name: "Painting" })).toBeTruthy();
    expect(screen.getByText("Fort Lauderdale 33301")).toBeTruthy();
    expect(screen.getByText("Fri, Oct 30")).toBeTruthy();
    expect(screen.getByText("2 h ago")).toBeTruthy();
    expect(screen.getByText(detail().description)).toBeTruthy();
    expect(screen.queryByTestId("opportunity-redacted")).toBeNull();

    // Two thumbnails and a video tile with a play glyph, read as one group with the pending count.
    expect(image(0)?.props.source).toEqual({ uri: mediaItem(1).url });
    expect(image(1)?.props.source).toEqual({ uri: mediaItem(2).url });
    expect(image(2)).toBeNull();
    expect(
      within(screen.getByTestId("opportunity-media-2", HIDDEN)).getByTestId("media-play", HIDDEN),
    ).toBeTruthy();
    expect(screen.getByLabelText("2 photos, 1 video, 2 more being prepared")).toBeTruthy();
    expect(screen.getByText("2 more being prepared")).toBeTruthy();
    expect(frames()).toHaveLength(0);

    expect(cachedList(client).map((item) => item.viewed)).toEqual([true, false]);
  });

  it("offers Send a quote once loaded, which opens the quote form over it", async () => {
    await renderWithQuery(<OpportunityDetailScreen />);
    expect(screen.queryByTestId("opportunity-send-quote")).toBeNull();
    await screen.findByText("JF-000124");

    const send = screen.getByRole("button", { name: "Send a quote" });
    await fireEvent.press(send);
    expect(router.push).toHaveBeenCalledWith({
      pathname: "/opportunities/[id]/quote",
      params: { id: DISPATCH_ID },
    });

    // A second tap while the push is queued opens nothing; once the router is idle it opens again.
    await fireEvent.press(send);
    expect(router.push).toHaveBeenCalledTimes(1);
    await act(async () => navigation.setNavigating(true));
    await act(async () => navigation.setNavigating(false));
    await fireEvent.press(send);
    expect(router.push).toHaveBeenCalledTimes(2);
  });

  it("says when contact details were hidden", async () => {
    jest.mocked(apiGet).mockResolvedValue(detail({ text_redacted: true }));
    await renderWithQuery(<OpportunityDetailScreen />);

    expect(await screen.findByText("Contact details were hidden.")).toBeTruthy();
  });

  it.each([
    ["only the pending note", 1, "1 more being prepared"],
    ["no media section", 0, null],
  ])("with nothing ready shows %s", async (_, pending, note) => {
    jest.mocked(apiGet).mockResolvedValue(detail({ media: [], media_pending: pending }));
    await renderWithQuery(<OpportunityDetailScreen />);

    await screen.findByText("JF-000124");
    expect(screen.queryByTestId("opportunity-media-0", HIDDEN)).toBeNull();
    if (note) expect(screen.getByText(note)).toBeTruthy();
    else expect(screen.queryByTestId("opportunity-media")).toBeNull();
  });

  it("404 says the request is gone, offers home, and evicts it from the list", async () => {
    jest.mocked(apiGet).mockRejectedValue(new ApiError(404, "not_found"));
    const client = seededClient();
    await renderWithQuery(<OpportunityDetailScreen />, client);

    expect(await screen.findByText("This request is no longer available")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(screen.queryByTestId("opportunity-send-quote")).toBeNull();
    expect(cachedList(client).map((item) => item.dispatch_id)).toEqual([summary(2).dispatch_id]);

    await fireEvent.press(screen.getByRole("button", { name: "Go to home" }));
    expect(router.dismissTo).toHaveBeenCalledWith("/");
  });

  it.each([
    ["a network error", new NetworkError(false)],
    ["a 5xx", new ApiError(503, undefined)],
  ])("%s shows a retry, which fetches again", async (_, error) => {
    jest.mocked(apiGet).mockRejectedValueOnce(error);
    await renderWithQuery(<OpportunityDetailScreen />);

    expect(await screen.findByText("We couldn't load this request")).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("JF-000124")).toBeTruthy();
    expect(apiGet).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["a network error", new NetworkError(false)],
    ["a 500", new ApiError(500, undefined)],
  ])("after a 404, a later open that ends in %s never shows the old request", async (_, error) => {
    const client = seededClient();
    const first = await renderWithQuery(<OpportunityDetailScreen />, client);
    await screen.findByText("JF-000124");
    expect(image(0)).toBeTruthy();
    await first.unmount();

    jest.mocked(apiGet).mockRejectedValueOnce(new ApiError(404, "not_found"));
    const second = await renderWithQuery(<OpportunityDetailScreen />, client);
    expect(await screen.findByText("This request is no longer available")).toBeTruthy();
    expect(screen.queryByTestId("opportunity-body")).toBeNull();
    // The detail, signed URLs included, left the cache; the list row too.
    expect(client.getQueryData(opportunityQueryKey(DISPATCH_ID))).toBeUndefined();
    expect(cachedList(client).map((item) => item.dispatch_id)).toEqual([summary(2).dispatch_id]);
    expect(apiGet).toHaveBeenCalledTimes(2);
    // Coming back to the screen asks for nothing more: the denial holds for this open.
    await act(async () => navigation.setFocused(false));
    await act(async () => navigation.setFocused(true));
    await act(async () => jest.advanceTimersByTime(1000));
    expect(apiGet).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("opportunity-body")).toBeNull();
    await second.unmount();

    jest.mocked(apiGet).mockRejectedValueOnce(error);
    await renderWithQuery(<OpportunityDetailScreen />, client);
    expect(await screen.findByText("We couldn't load this request")).toBeTruthy();
    expect(screen.queryByTestId("opportunity-body")).toBeNull();
    expect(JSON.stringify(screen.toJSON())).not.toContain("media.test.invalid");
    expect(apiGet).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["a network error", new NetworkError(false)],
    ["a 503", new ApiError(503, undefined)],
  ])(
    "a media refresh that fails with %s keeps the text, hides the expired media and offers a retry",
    async (_, error) => {
      fakeClock();
      jest
        .mocked(apiGet)
        .mockResolvedValueOnce(detail())
        .mockRejectedValueOnce(error)
        .mockResolvedValue(FRESH);
      await renderWithQuery(<OpportunityDetailScreen />);
      await screen.findByText("JF-000124");
      expect(image(0)).toBeTruthy();

      // The URLs pass on the focused screen: the refetch fails.
      await advanceMinutes(5);
      await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
      expect(await screen.findByText("We couldn't refresh the photos and videos.")).toBeTruthy();
      expect(screen.getByTestId("opportunity-description")).toBeTruthy();
      expect(image(0)).toBeNull();
      expect(frames()).toHaveLength(0);
      expect(JSON.stringify(screen.toJSON())).not.toContain("media.test.invalid");

      await fireEvent.press(screen.getByRole("button", { name: "Try again" }));
      await waitFor(() => expect(image(0)?.props.source).toEqual({ uri: FRESH.media[0]?.url }));
      expect(apiGet).toHaveBeenCalledTimes(3);
      expect(screen.queryByText("We couldn't refresh the photos and videos.")).toBeNull();
      expect(frames()).toHaveLength(0);
    },
  );

  it("an expired URL is never shown, and the detail is fetched again on focus", async () => {
    fakeClock();
    jest.mocked(apiGet).mockResolvedValueOnce(detail()).mockResolvedValue(FRESH);
    await renderWithQuery(<OpportunityDetailScreen />);
    await screen.findByText("JF-000124");
    expect(image(0)).toBeTruthy();

    // Away from the screen while the URLs pass: quiet frames, no broken image, no request.
    await act(async () => navigation.setFocused(false));
    await advanceMinutes(5);
    expect(image(0)).toBeNull();
    expect(frames()).toHaveLength(3);
    expect(apiGet).toHaveBeenCalledTimes(1);

    // Back on it: fresh URLs, and nothing more once they are fresh.
    await act(async () => navigation.setFocused(true));
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(image(0)?.props.source).toEqual({ uri: FRESH.media[0]?.url }));
    expect(frames()).toHaveLength(0);
    await act(async () => jest.advanceTimersByTime(MINUTE_MS));
    expect(apiGet).toHaveBeenCalledTimes(2);
  });

  it("the moment a URL expires on a focused screen, the detail is fetched again", async () => {
    fakeClock();
    jest.mocked(apiGet).mockResolvedValueOnce(detail()).mockResolvedValue(FRESH);
    await renderWithQuery(<OpportunityDetailScreen />);
    await screen.findByText("JF-000124");

    await advanceMinutes(5);

    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(image(0)?.props.source).toEqual({ uri: FRESH.media[0]?.url }));
  });

  it("an answer whose URLs were already past when it arrived is not asked for again", async () => {
    fakeClock();
    jest
      .mocked(apiGet)
      .mockResolvedValue(
        detail({ media: [mediaItem(1, { expires_at: minutesFromNow(-1) })], media_pending: 0 }),
      );
    await renderWithQuery(<OpportunityDetailScreen />);
    await screen.findByText("JF-000124");

    expect(image(0)).toBeNull();
    expect(frames()).toHaveLength(1);
    await act(async () => navigation.setFocused(false));
    await act(async () => navigation.setFocused(true));
    await act(async () => jest.advanceTimersByTime(MINUTE_MS));
    expect(apiGet).toHaveBeenCalledTimes(1);
  });

  it("Back pops with history, and goes to the home without any (a deep link)", async () => {
    await renderWithQuery(<OpportunityDetailScreen />);
    await screen.findByText("JF-000124");

    await fireEvent.press(screen.getByRole("button", { name: "Back" }));
    expect(router.back).toHaveBeenCalledTimes(1);
    expect(router.replace).not.toHaveBeenCalled();

    await act(async () => navigation.setCanGoBack(false));
    await fireEvent.press(screen.getByRole("button", { name: "Back" }));
    expect(router.replace).toHaveBeenCalledWith("/");
  });
});
