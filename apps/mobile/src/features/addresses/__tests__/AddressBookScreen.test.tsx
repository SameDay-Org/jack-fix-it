import { act, fireEvent, screen, waitFor, within } from "@testing-library/react-native";
import { router } from "expo-router";

import { apiGet, NetworkError, useSession } from "@/api";
import i18n from "@/i18n";

import { settle } from "../../../api/__tests__/helpers";
import { signedIn } from "../../home/__tests__/helpers";
import { AddressBookScreen } from "../AddressBookScreen";
import { bookClient, CABIN, HOME, renderAddresses, WORK } from "./helpers";

jest.mock("@/api", () => ({
  ...jest.requireActual("../../../api/errors"),
  apiDelete: jest.fn(),
  apiGet: jest.fn(),
  apiPatch: jest.fn(),
  apiPost: jest.fn(),
  isCurrentGeneration: jest.fn(() => true),
  sessionGeneration: jest.fn(() => 1),
  useSession: jest.fn(),
}));
// Where a redirect sends the screen; it draws nothing.
const mockRedirect = jest.fn((_props: { href: string }) => null);
jest.mock("expo-router", () => ({
  router: { push: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true), replace: jest.fn() },
  Redirect: (props: { href: string }) => mockRedirect(props),
}));
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);

beforeEach(() => {
  jest.mocked(useSession).mockReturnValue(signedIn());
  jest
    .mocked(apiGet)
    .mockReset()
    .mockResolvedValue({ items: [HOME, WORK, CABIN] });
  jest.mocked(router.push).mockClear();
});

afterEach(async () => {
  await act(() => settle());
  await i18n.changeLanguage("en");
});

describe("AddressBookScreen", () => {
  it("lists the book: the default first with its chip, each address on a line", async () => {
    await renderAddresses(<AddressBookScreen />);

    expect(screen.getByRole("header", { name: "Addresses" })).toBeOnTheScreen();
    const home = await screen.findByTestId("address-home");
    expect(within(home).getByText("Default")).toBeOnTheScreen();
    expect(within(home).getByText("12 Main St, Newark, NJ 07102")).toBeOnTheScreen();
    expect(screen.queryByTestId("address-work-default")).toBeNull();
    expect(
      screen.getByRole("button", {
        name: "Work, 500 Market St, Suite 12, Newark, NJ 07102",
      }),
    ).toBeOnTheScreen();
    // Each row reads as one button with its state, and its menu as another.
    expect(
      screen.getByRole("button", { name: "Home, Default, 12 Main St, Newark, NJ 07102" }),
    ).toBeOnTheScreen();
    expect(screen.getByRole("button", { name: "Options for Home" })).toBeOnTheScreen();
    expect(screen.getByRole("button", { name: "Add address" })).toBeOnTheScreen();
  });

  it("says when an address's ZIP is outside the service areas", async () => {
    await renderAddresses(<AddressBookScreen />);

    expect(await screen.findByTestId("address-cabin-not-served")).toHaveTextContent(
      "We don't serve this ZIP code yet.",
    );
    expect(screen.queryByTestId("address-home-not-served")).toBeNull();
  });

  it("opens an address to edit, its menu, and Add", async () => {
    await renderAddresses(<AddressBookScreen />);

    await fireEvent.press(await screen.findByTestId("address-work-edit"));
    await fireEvent.press(screen.getByRole("button", { name: "Options for Work" }));
    await fireEvent.press(screen.getByRole("button", { name: "Add address" }));

    expect(jest.mocked(router.push).mock.calls).toEqual([
      [{ pathname: "/account/addresses/[id]", params: { id: "work" } }],
      [{ pathname: "/account/addresses/[id]/actions", params: { id: "work" } }],
      ["/account/addresses/new"],
    ]);
  });

  it("an empty book says what it is for, with Add", async () => {
    jest.mocked(apiGet).mockResolvedValue({ items: [] });
    await renderAddresses(<AddressBookScreen />);

    const empty = await screen.findByTestId("address-book-empty");
    expect(within(empty).getByRole("header", { name: "No saved addresses yet" })).toBeTruthy();
    await fireEvent.press(within(empty).getByRole("button", { name: "Add address" }));

    expect(router.push).toHaveBeenCalledWith("/account/addresses/new");
    expect(screen.queryByTestId("address-book-list")).toBeNull();
  });

  it("holds rows shaped like the book while it loads", async () => {
    jest.mocked(apiGet).mockReturnValue(new Promise(() => undefined));
    await renderAddresses(<AddressBookScreen />);

    expect(screen.getByTestId("address-book-loading").props.accessibilityLabel).toBe("Loading");
    expect(screen.queryByRole("button", { name: "Add address" })).toBeNull();
  });

  it("says when the book could not load, and retries", async () => {
    jest.mocked(apiGet).mockRejectedValueOnce(new NetworkError(false));
    await renderAddresses(<AddressBookScreen />);

    await fireEvent.press(await screen.findByRole("button", { name: "Try again" }));

    expect(await screen.findByTestId("address-home")).toBeOnTheScreen();
    expect(screen.queryByTestId("address-book-failed")).toBeNull();
    expect(apiGet).toHaveBeenCalledTimes(2);
  });

  it("keeps the book on screen when a refresh fails", async () => {
    jest.mocked(apiGet).mockRejectedValue(new NetworkError(false));
    await renderAddresses(<AddressBookScreen />, bookClient([HOME]));

    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    expect(screen.getByTestId("address-home")).toBeOnTheScreen();
    expect(screen.queryByTestId("address-book-failed")).toBeNull();
  });

  it("is a customer's: anyone else goes back to Account, and nothing is asked", async () => {
    jest.mocked(useSession).mockReturnValue(signedIn({ role: "pro" }));
    await renderAddresses(<AddressBookScreen />);

    expect(mockRedirect.mock.calls[0][0]).toEqual({ href: "/account" });
    expect(apiGet).not.toHaveBeenCalled();
  });

  it("reads in Spanish", async () => {
    await i18n.changeLanguage("es");
    await renderAddresses(<AddressBookScreen />);

    expect(screen.getByRole("header", { name: "Direcciones" })).toBeOnTheScreen();
    expect(await screen.findByText("Predeterminada")).toBeOnTheScreen();
    expect(screen.getByRole("button", { name: "Opciones de Home" })).toBeOnTheScreen();
    expect(screen.getByRole("button", { name: "Agregar dirección" })).toBeOnTheScreen();
  });
});
