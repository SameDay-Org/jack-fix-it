import i18n from "@/i18n";

import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import { router } from "expo-router";

import { ApiError, apiGet, NetworkError, useSession } from "@/api";
import { requestDraftStore } from "@/features/request";

import { deferred } from "../../../api/__tests__/helpers";
import { CustomerHomeScreen } from "../CustomerHomeScreen";
import { CATEGORIES, newQueryClient, renderWithQuery, signedIn } from "./helpers";

jest.mock("@/api", () => ({
  ...jest.requireActual("../../../api/errors"),
  apiGet: jest.fn(),
  useSession: jest.fn(),
  logout: jest.fn(),
}));
jest.mock("expo-router", () => ({ router: { push: jest.fn() } }));
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);

const tellJack = () => screen.getByRole("button", { name: "Tell Jack What Happened" });
const cardNames = () =>
  screen
    .getAllByRole("button")
    .filter((button) => String(button.props.testID).startsWith("home-category-"))
    .map((button) => button.props.accessibilityLabel as string);

describe("CustomerHomeScreen", () => {
  beforeEach(() => {
    jest.mocked(useSession).mockReturnValue(signedIn());
    jest.mocked(apiGet).mockReset().mockResolvedValue(CATEGORIES);
    jest.mocked(router.push).mockClear();
    requestDraftStore.setState({ categorySlug: null });
  });

  afterEach(async () => {
    await act(() => i18n.changeLanguage("en"));
  });

  it("shows the headline, support line and one primary action", async () => {
    await renderWithQuery(<CustomerHomeScreen />);
    await screen.findByRole("button", { name: "Painting" });

    expect(screen.getByRole("header", { name: "What's going on at home?" })).toBeTruthy();
    expect(screen.getByText("Tell Jack. We'll take care of the rest.")).toBeTruthy();
    expect(tellJack()).toBeTruthy();
    // The kit's primary pill is the only green surface: cards and the account button are not primary.
    const primary = screen
      .getAllByRole("button")
      .filter((button) => String(button.props.className).includes("bg-green-500"));
    expect(primary).toEqual([tellJack()]);
  });

  it("tell jack clears the draft category and opens the request start", async () => {
    requestDraftStore.setState({ categorySlug: "painting" });
    await renderWithQuery(<CustomerHomeScreen />);

    await fireEvent.press(tellJack());

    expect(requestDraftStore.getState().categorySlug).toBeNull();
    expect(router.push).toHaveBeenCalledWith("/request/new");
  });

  it("shows card skeletons while categories load", async () => {
    const pending = deferred<typeof CATEGORIES>();
    jest.mocked(apiGet).mockReturnValue(pending.promise);
    await renderWithQuery(<CustomerHomeScreen />);

    expect(screen.getByRole("header", { name: "Or pick a category" })).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Loading categories" })).toBeTruthy();
    expect(
      screen.getAllByTestId(/^home-category-skeleton-\d+$/, { includeHiddenElements: true }),
    ).toHaveLength(5);
    expect(cardNames()).toEqual([]);

    await act(async () => pending.resolve(CATEGORIES));

    await waitFor(() => expect(cardNames()).toHaveLength(5));
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("lists categories in API order with localized names (en)", async () => {
    await renderWithQuery(<CustomerHomeScreen />);

    await screen.findByRole("button", { name: "Painting" });
    expect(cardNames()).toEqual([
      "House Cleaning",
      "Handyman",
      "Painting",
      "Lawn & Landscaping",
      "Moving & Assembly",
    ]);
    expect(apiGet).toHaveBeenCalledWith("/v1/categories", expect.anything());
  });

  it("lists categories in API order with localized names (es; a missing es falls back to en)", async () => {
    await act(() => i18n.changeLanguage("es"));
    await renderWithQuery(<CustomerHomeScreen />);

    await screen.findByRole("button", { name: "Pintura" });
    expect(cardNames()).toEqual([
      "Limpieza del hogar",
      "Reparaciones generales",
      "Pintura",
      "Jardinería y paisajismo",
      "Moving & Assembly",
    ]);
    expect(screen.getByRole("header", { name: "O elige una categoría" })).toBeTruthy();
  });

  it("pressing a card starts a request for its slug", async () => {
    await renderWithQuery(<CustomerHomeScreen />);

    await fireEvent.press(await screen.findByRole("button", { name: "Lawn & Landscaping" }));

    expect(requestDraftStore.getState().categorySlug).toBe("lawn-landscaping");
    expect(router.push).toHaveBeenCalledWith("/request/new");
  });

  it("back on home: the cards are still there, with no refetch and no skeleton", async () => {
    const client = newQueryClient();
    const first = await renderWithQuery(<CustomerHomeScreen />, client);
    await screen.findByRole("button", { name: "Painting" });
    await first.unmount();

    await renderWithQuery(<CustomerHomeScreen />, client);

    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(cardNames()).toHaveLength(5);
    expect(apiGet).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["offline", new NetworkError(false)],
    ["past the timeout", new NetworkError(true)],
    ["rate limited", new ApiError(429, "rate_limited")],
    ["a server error", new ApiError(503, "unavailable")],
  ])("a failed load (%s) shows the error and Try again refetches", async (_, error) => {
    jest.mocked(apiGet).mockRejectedValueOnce(error);
    await renderWithQuery(<CustomerHomeScreen />);

    expect(await screen.findByText("We couldn't load the categories.")).toBeTruthy();
    expect(cardNames()).toEqual([]);
    expect(apiGet).toHaveBeenCalledTimes(1); // no silent retries behind the message

    await fireEvent.press(tellJack()); // the hero keeps working
    expect(router.push).toHaveBeenCalledWith("/request/new");

    const retry = deferred<typeof CATEGORIES>();
    jest.mocked(apiGet).mockReturnValueOnce(retry.promise);
    await fireEvent.press(screen.getByRole("button", { name: "Try again" }));

    // In flight, the card skeletons come back in place of the message.
    expect(await screen.findByRole("progressbar", { name: "Loading categories" })).toBeTruthy();
    expect(screen.queryByText("We couldn't load the categories.")).toBeNull();
    await act(async () => retry.resolve(CATEGORIES));

    await waitFor(() => expect(cardNames()).toHaveLength(5));
    expect(apiGet).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("We couldn't load the categories.")).toBeNull();
  });

  it("an empty catalog hides the section", async () => {
    jest.mocked(apiGet).mockResolvedValue([]);
    await renderWithQuery(<CustomerHomeScreen />);

    await waitFor(() => expect(screen.queryByTestId("home-categories")).toBeNull());
    expect(screen.queryByText("Or pick a category")).toBeNull();
    expect(tellJack()).toBeTruthy();
  });

  it("the account button opens /account", async () => {
    jest.mocked(useSession).mockReturnValue(signedIn({ first_name: "Maria", last_name: "Lopez" }));
    await renderWithQuery(<CustomerHomeScreen />);

    const account = screen.getByRole("button", { name: "Account" });
    expect(account.props.className).toContain("min-h-12"); // 48 dp target
    expect(screen.getByText("ML", { includeHiddenElements: true })).toBeTruthy();
    await fireEvent.press(account);

    expect(router.push).toHaveBeenCalledWith("/account");
  });

  it("an account without a name: the email's first letter", async () => {
    await renderWithQuery(<CustomerHomeScreen />);

    expect(screen.getByText("M", { includeHiddenElements: true })).toBeTruthy();
  });
});
