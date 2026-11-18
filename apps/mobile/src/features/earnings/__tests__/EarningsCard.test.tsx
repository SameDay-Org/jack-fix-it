import "@/i18n";

import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import { router } from "expo-router";

import { ApiError, apiGet, useSession } from "@/api";

import { earningsQueryKey, type EarningsPage } from "../api";
import { EarningsCard } from "../EarningsCard";
import {
  earning,
  earningsCursors,
  earningsPage,
  freezeClock,
  navigation,
  newQueryClient,
  ON_THE_WAY,
  renderWithQuery,
  routeApi,
  signedIn,
  ZERO,
} from "./helpers";

jest.mock("@/api", () => jest.requireActual("./helpers").apiMock());
jest.mock("expo-router", () => jest.requireActual("./helpers").routerMock);
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);
jest.mock("react-native-reanimated", () => ({
  __esModule: true,
  ...jest.requireActual<typeof import("react-native-reanimated")>("react-native-reanimated"),
  useReducedMotion: jest.fn(() => true),
}));

const mockApiGet = jest.mocked(apiGet);
const noProfile = () => Promise.reject(new Error("the card never reads the profile"));
const answer = (page: EarningsPage | Error) =>
  routeApi(
    mockApiGet,
    () => (page instanceof Error ? Promise.reject(page) : Promise.resolve(page)),
    noProfile,
  );

beforeEach(() => {
  freezeClock();
  navigation.reset();
  jest.mocked(useSession).mockReturnValue(signedIn({ role: "pro" }));
  mockApiGet.mockReset();
  jest.mocked(router.push).mockClear();
});

afterEach(() => jest.useRealTimers());

describe("EarningsCard", () => {
  it("shows what was paid, read as one, and opens the Earnings screen", async () => {
    answer(earningsPage([earning(1)]));
    await renderWithQuery(<EarningsCard />);

    expect(await screen.findByTestId("earnings-card-paid")).toHaveTextContent("$1,540.00");
    const card = screen.getByTestId("earnings-card");
    expect(card.props.accessibilityLabel).toBe("Earnings. Paid, $1,540.00");
    await fireEvent.press(card);
    expect(router.push).toHaveBeenCalledWith("/pro/earnings");
  });

  it("before any finished job, says where earnings will show", async () => {
    answer(earningsPage([], null, ZERO));
    await renderWithQuery(<EarningsCard />);

    expect(
      await screen.findByText("Your earnings will show here after your first finished job."),
    ).toBeTruthy();
    expect(screen.queryByTestId("earnings-card-paid")).toBeNull();
  });

  it("a total that did not load still opens the screen, where it is retried", async () => {
    answer(new ApiError(429, "rate_limited"));
    await renderWithQuery(<EarningsCard />);

    expect(await screen.findByText("Your total didn't load. Open to try again.")).toBeTruthy();
    expect(screen.queryByText(/rate_limited/)).toBeNull();
    await fireEvent.press(screen.getByTestId("earnings-card"));
    expect(router.push).toHaveBeenCalledWith("/pro/earnings");
  });

  it("a return to the home asks for the first page only, whatever the screen scrolled", async () => {
    const client = newQueryClient();
    answer(earningsPage([earning(1)], "c1"));
    await renderWithQuery(<EarningsCard />, client);
    await screen.findByTestId("earnings-card-paid");
    expect(earningsCursors(mockApiGet)).toEqual([undefined]);

    // The pro opens Earnings and scrolls: the shared cache now holds two pages.
    await act(async () => navigation.setFocused(false));
    client.setQueryData(earningsQueryKey(1), {
      pages: [earningsPage([earning(1)], "c1"), earningsPage([ON_THE_WAY])],
      pageParams: [undefined, "c1"],
    });
    await act(async () => navigation.setFocused(true));
    await waitFor(() => expect(earningsCursors(mockApiGet)).toEqual([undefined, undefined]));
    await waitFor(() =>
      expect(client.getQueryState(earningsQueryKey(1))?.fetchStatus).toBe("idle"),
    );
    const data = client.getQueryData<{ pages: EarningsPage[] }>(earningsQueryKey(1));
    expect(data?.pages).toHaveLength(1);
  });
});
