import "@/i18n";

import { screen } from "@testing-library/react-native";

import { apiGet, useSession } from "@/api";

import { HomeScreen } from "../HomeScreen";
import { CATEGORIES, renderWithQuery, signedIn } from "./helpers";

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

describe("index route", () => {
  beforeEach(() => jest.mocked(apiGet).mockReset().mockResolvedValue(CATEGORIES));

  it("customer gets the customer home", async () => {
    jest.mocked(useSession).mockReturnValue(signedIn({ role: "customer" }));

    await renderWithQuery(<HomeScreen />);

    expect(await screen.findByRole("button", { name: "Painting" })).toBeTruthy();
    expect(screen.getByTestId("customer-home")).toBeTruthy();
    expect(screen.queryByTestId("home-screen")).toBeNull();
  });

  it.each(["pro", "agent", "admin"] as const)("%s gets the placeholder", async (role) => {
    jest.mocked(useSession).mockReturnValue(signedIn({ role }));

    await renderWithQuery(<HomeScreen />);

    expect(screen.getByTestId("home-screen")).toBeTruthy();
    expect(screen.queryByTestId("customer-home")).toBeNull();
    expect(apiGet).not.toHaveBeenCalled();
  });
});
