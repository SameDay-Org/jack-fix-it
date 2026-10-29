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
jest.mock("expo-router", () => ({
  router: { push: jest.fn() },
  useIsFocused: () => true,
  useScrollToTop: jest.fn(),
}));
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);

const cardNames = () =>
  screen
    .queryAllByRole("button")
    .filter((button) => String(button.props.testID).startsWith("home-category-"))
    .map((button) => button.props.accessibilityLabel as string);

/** Every text run in the rendered tree, in tree order (the order a screen reader walks). */
const textRuns = (node: unknown, runs: string[] = []): string[] => {
  if (typeof node === "string") runs.push(node);
  else if (Array.isArray(node)) node.forEach((child) => textRuns(child, runs));
  else if (node && typeof node === "object" && "children" in node) {
    textRuns((node as { children: unknown }).children, runs);
  }
  return runs;
};

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

  it("home has no tell-jack button and shows the new support line", async () => {
    await renderWithQuery(<CustomerHomeScreen />);
    await screen.findByRole("button", { name: "Painting" });

    expect(screen.getByText("Pick a category and Jack takes care of the rest.")).toBeTruthy();
    expect(screen.queryByTestId("home-tell-jack")).toBeNull();
    expect(screen.queryByRole("button", { name: /tell jack/i })).toBeNull();
    expect(screen.queryByText(/tell jack/i)).toBeNull();
    expect(screen.queryByLabelText(/tell jack/i)).toBeNull();
    // No primary pill is left on home: the cards are the way in.
    const primary = screen
      .getAllByRole("button")
      .filter((button) => String(button.props.className).includes("bg-green-500"));
    expect(primary).toEqual([]);
    // Reading order: headline, support line, categories title, then the cards.
    const headers = screen.getAllByRole("header");
    expect(headers).toHaveLength(2);
    expect(headers[0]).toHaveTextContent("What's going on at home?");
    expect(headers[1]).toHaveTextContent("Categories");
    const runs = textRuns(screen.toJSON());
    const at = (text: string) => runs.indexOf(text);
    expect(at("What's going on at ")).toBeGreaterThan(-1); // the headline's first run
    expect(at("What's going on at ")).toBeLessThan(
      at("Pick a category and Jack takes care of the rest."),
    );
    expect(at("Pick a category and Jack takes care of the rest.")).toBeLessThan(at("Categories"));
    expect(at("Categories")).toBeLessThan(at("House Cleaning")); // the first card
  });

  it("home has no tell-jack button and shows the new support line (es)", async () => {
    await act(() => i18n.changeLanguage("es"));
    await renderWithQuery(<CustomerHomeScreen />);
    await screen.findByRole("button", { name: "Pintura" });

    expect(screen.getByRole("header", { name: "¿Qué está pasando en casa?" })).toBeTruthy();
    expect(screen.getByText("Elige una categoría y Jack se encarga del resto.")).toBeTruthy();
    expect(screen.getByRole("header", { name: "Categorías" })).toBeTruthy();
    expect(screen.queryByTestId("home-tell-jack")).toBeNull();
    expect(screen.queryByText(/dile a jack/i)).toBeNull();
    expect(screen.queryByLabelText(/dile a jack/i)).toBeNull();
  });

  it("shows card skeletons while categories load", async () => {
    const pending = deferred<typeof CATEGORIES>();
    jest.mocked(apiGet).mockReturnValue(pending.promise);
    await renderWithQuery(<CustomerHomeScreen />);

    expect(screen.getByRole("header", { name: "Categories" })).toBeTruthy();
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
    expect(screen.getByRole("header", { name: "Categorías" })).toBeTruthy();
  });

  it("a category card starts a request with its slug", async () => {
    requestDraftStore.setState({ categorySlug: "painting" }); // an earlier start is replaced
    await renderWithQuery(<CustomerHomeScreen />);

    await fireEvent.press(await screen.findByRole("button", { name: "Lawn & Landscaping" }));

    expect(requestDraftStore.getState().categorySlug).toBe("lawn-landscaping");
    expect(router.push).toHaveBeenCalledTimes(1);
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
    expect(screen.getByRole("header", { name: "What's going on at home?" })).toBeTruthy(); // the hero stays

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
    expect(screen.queryByText("Categories")).toBeNull();
    expect(screen.getByRole("header", { name: "What's going on at home?" })).toBeTruthy();
    expect(screen.getByText("Pick a category and Jack takes care of the rest.")).toBeTruthy();
  });

  it("customer home has no AccountButton: Account is a tab (#213)", async () => {
    jest.mocked(useSession).mockReturnValue(signedIn({ first_name: "Maria", last_name: "Lopez" }));
    await renderWithQuery(<CustomerHomeScreen />);
    await screen.findByRole("button", { name: "Painting" });

    expect(screen.queryByTestId("home-account")).toBeNull();
    expect(screen.queryByRole("button", { name: "Account" })).toBeNull();
    expect(screen.queryByText("ML", { includeHiddenElements: true })).toBeNull();
    expect(router.push).not.toHaveBeenCalled();
  });
});
