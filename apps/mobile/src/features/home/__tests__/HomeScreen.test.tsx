import "@/i18n";

import { screen } from "@testing-library/react-native";

import { apiGet, useSession } from "@/api";

import { HomeScreen } from "../HomeScreen";
import { CATEGORIES, renderWithQuery, signedIn } from "./helpers";

jest.mock("@/api", () => ({
  ...jest.requireActual("../../../api/errors"),
  onSignOut: jest.fn(),
  apiGet: jest.fn(),
  useSession: jest.fn(),
  logout: jest.fn(),
}));
jest.mock("expo-router", () => {
  const { useEffect } = jest.requireActual<typeof import("react")>("react");
  return {
    router: { push: jest.fn() },
    useFocusEffect: (effect: () => void | (() => void)) => useEffect(() => effect(), [effect]),
    unstable_useIsNavigating: () => false,
    useIsFocused: () => true,
    useScrollToTop: jest.fn(),
  };
});
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);

const NO_OPPORTUNITIES = { items: [], next_cursor: null };

describe("index route", () => {
  beforeEach(() =>
    jest
      .mocked(apiGet)
      .mockReset()
      .mockImplementation((async (path: string) =>
        path === "/v1/categories" ? CATEGORIES : NO_OPPORTUNITIES) as unknown as typeof apiGet),
  );

  it("customer gets the customer home", async () => {
    jest.mocked(useSession).mockReturnValue(signedIn({ role: "customer" }));

    await renderWithQuery(<HomeScreen />);

    expect(await screen.findByRole("button", { name: "Painting" })).toBeTruthy();
    expect(screen.getByTestId("customer-home")).toBeTruthy();
    expect(screen.queryByTestId("pro-home")).toBeNull();
    expect(screen.queryByTestId("home-screen")).toBeNull();
  });

  it("pro gets the pro home with the new opportunities", async () => {
    jest.mocked(useSession).mockReturnValue(signedIn({ role: "pro", first_name: "Dan" }));

    await renderWithQuery(<HomeScreen />);

    expect(screen.getByTestId("pro-home")).toBeTruthy();
    expect(screen.getByRole("header", { name: "Hi, Dan" })).toBeTruthy();
    expect(screen.getByRole("header", { name: "New opportunities" })).toBeTruthy();
    expect(await screen.findByText("No new requests right now")).toBeTruthy();
    expect(apiGet).toHaveBeenCalledWith(
      "/v1/pros/me/opportunities",
      expect.objectContaining({ auth: true }),
    );
    expect(screen.queryByTestId("customer-home")).toBeNull();
    expect(screen.queryByTestId("home-screen")).toBeNull();
  });

  it.each(["agent", "admin"] as const)("%s gets the placeholder", async (role) => {
    jest.mocked(useSession).mockReturnValue(signedIn({ role }));

    await renderWithQuery(<HomeScreen />);

    expect(screen.getByTestId("home-screen")).toBeTruthy();
    expect(screen.queryByTestId("customer-home")).toBeNull();
    expect(screen.queryByTestId("pro-home")).toBeNull();
    expect(apiGet).not.toHaveBeenCalled();
  });
});
