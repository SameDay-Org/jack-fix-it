import i18n from "@/i18n";

import { act, screen } from "@testing-library/react-native";

import { apiGet } from "@/api";
import { CATEGORIES_QUERY_KEY } from "@/features/home/useCategories";

import { CATEGORIES, newQueryClient, renderWithQuery } from "../../home/__tests__/helpers";
import { RequestStartPlaceholderScreen } from "../RequestStartPlaceholderScreen";
import { requestDraftStore } from "../requestDraft";

jest.mock("@/api", () => ({
  ...jest.requireActual("../../../api/errors"),
  apiGet: jest.fn(),
}));
jest.mock("expo-router", () => ({ router: { push: jest.fn() } }));
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);

/** Home already loaded the catalog: the placeholder reads it from the cache. */
const loadedClient = () => {
  const client = newQueryClient();
  client.setQueryData(CATEGORIES_QUERY_KEY, CATEGORIES);
  return client;
};

describe("RequestStartPlaceholderScreen", () => {
  afterEach(async () => {
    requestDraftStore.setState({ categorySlug: null });
    await act(() => i18n.changeLanguage("en"));
  });

  it("shows the drafted category name, from the catalog home loaded", async () => {
    requestDraftStore.setState({ categorySlug: "painting" });

    await renderWithQuery(<RequestStartPlaceholderScreen />, loadedClient());

    expect(screen.getByRole("header", { name: "Tell Jack what happened" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();
    expect(screen.getByTestId("request-start-category")).toHaveTextContent("Painting");
    expect(apiGet).not.toHaveBeenCalled();
  });

  it("shows the drafted category name in Spanish", async () => {
    await act(() => i18n.changeLanguage("es"));
    requestDraftStore.setState({ categorySlug: "house-cleaning" });

    await renderWithQuery(<RequestStartPlaceholderScreen />, loadedClient());

    expect(screen.getByTestId("request-start-category")).toHaveTextContent("Limpieza del hogar");
  });

  it("shows no category when the request started from Tell Jack", async () => {
    await renderWithQuery(<RequestStartPlaceholderScreen />, loadedClient());

    expect(screen.getByRole("header", { name: "Tell Jack what happened" })).toBeTruthy();
    expect(screen.queryByTestId("request-start-category")).toBeNull();
  });
});
