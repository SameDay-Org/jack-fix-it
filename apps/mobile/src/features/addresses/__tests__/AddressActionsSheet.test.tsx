import { act, fireEvent, screen } from "@testing-library/react-native";
import { router, useLocalSearchParams } from "expo-router";
import { Alert, type AlertButton, type AlertOptions } from "react-native";

import { ApiError, apiDelete, apiGet, apiPatch, useSession } from "@/api";
import { dismissToast, toastStore } from "@/components/ui/toast";
import i18n from "@/i18n";

import { deferred, settle } from "../../../api/__tests__/helpers";
import { signedIn } from "../../home/__tests__/helpers";
import { AddressActionsSheet } from "../AddressActionsSheet";
import { bookClient, cachedBook, HOME, renderAddresses, WORK } from "./helpers";

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
jest.mock("expo-router", () => ({
  router: { push: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true), replace: jest.fn() },
  useLocalSearchParams: jest.fn(() => ({})),
}));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);

let alert: jest.SpyInstance;

beforeEach(() => {
  jest.mocked(useSession).mockReturnValue(signedIn());
  jest
    .mocked(apiGet)
    .mockReset()
    .mockResolvedValue({ items: [HOME, WORK] });
  jest.mocked(apiDelete).mockReset();
  jest.mocked(apiPatch).mockReset();
  jest.mocked(router.back).mockClear();
  alert = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
  toastStore.setState({ current: null });
});

afterEach(async () => {
  await act(() => settle());
  dismissToast();
  jest.restoreAllMocks();
  await i18n.changeLanguage("en");
});

const openFor = (id: string, client = bookClient([HOME, WORK])) => {
  jest.mocked(useLocalSearchParams).mockReturnValue({ id });
  return { client, view: renderAddresses(<AddressActionsSheet />, client) };
};
const buttons = (call = 0) => alert.mock.calls[call][2] as AlertButton[];

describe("AddressActionsSheet", () => {
  it("offers Make default and Delete for another address, under its name and line", async () => {
    const { view } = openFor("work");
    await view;

    expect(screen.getByText("Work")).toBeOnTheScreen();
    expect(screen.getByText("500 Market St, Suite 12, Newark, NJ 07102")).toBeOnTheScreen();
    expect(screen.getByRole("button", { name: "Make default" })).toBeOnTheScreen();
    expect(screen.getByRole("button", { name: "Delete address" })).toBeOnTheScreen();
  });

  it("makes it the default at once and closes", async () => {
    const answer = deferred<typeof WORK>();
    jest.mocked(apiPatch).mockReturnValue(answer.promise);
    const { client, view } = openFor("work");
    await view;

    await fireEvent.press(screen.getByRole("button", { name: "Make default" }));

    expect(router.back).toHaveBeenCalledTimes(1);
    expect(cachedBook(client)).toEqual(["work*", "home"]);
    expect(apiPatch).toHaveBeenCalledWith(
      "/v1/addresses/{address_id}",
      { is_default: true },
      { auth: true, generation: 1, params: { address_id: "work" } },
    );
    await act(async () => answer.resolve({ ...WORK, is_default: true }));
  });

  it("for the default, says so and offers Delete alone", async () => {
    const { view } = openFor("home");
    await view;

    expect(screen.getByTestId("address-actions-is-default")).toHaveTextContent(
      "This is your default address.",
    );
    expect(screen.queryByRole("button", { name: "Make default" })).toBeNull();
  });

  it("Delete asks first; Cancel keeps the address", async () => {
    const { client, view } = openFor("work");
    await view;

    await fireEvent.press(screen.getByRole("button", { name: "Delete address" }));
    // A second quick tap stacks no second dialog.
    await fireEvent.press(screen.getByRole("button", { name: "Delete address" }));

    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert.mock.calls[0][0]).toBe("Delete Work?");
    expect(alert.mock.calls[0][1]).toBe("Requests you already sent keep their address.");
    await act(async () => buttons()[0].onPress?.());
    expect(apiDelete).not.toHaveBeenCalled();
    expect(cachedBook(client)).toEqual(["home*", "work"]);
    expect(router.back).not.toHaveBeenCalled();

    // Answered, it can ask again; Back on Android dismisses it like Cancel.
    await fireEvent.press(screen.getByRole("button", { name: "Delete address" }));
    await act(async () => (alert.mock.calls[1][3] as AlertOptions).onDismiss?.());
    await fireEvent.press(screen.getByRole("button", { name: "Delete address" }));
    expect(alert).toHaveBeenCalledTimes(3);
  });

  it("Delete, confirmed, takes the address out at once and closes", async () => {
    jest.mocked(apiDelete).mockReturnValue(new Promise(() => undefined));
    const { client, view } = openFor("work");
    await view;

    await fireEvent.press(screen.getByRole("button", { name: "Delete address" }));
    await act(async () => buttons()[1].onPress?.());

    expect(buttons()[1].style).toBe("destructive");
    expect(cachedBook(client)).toEqual(["home*"]);
    expect(router.back).toHaveBeenCalledTimes(1);
    // The sheet keeps showing what it was opened for while it closes.
    expect(screen.getByText("Work")).toBeOnTheScreen();
  });

  it("deleting the default names the address that becomes the default", async () => {
    const { view } = openFor("home");
    await view;

    await fireEvent.press(screen.getByRole("button", { name: "Delete address" }));

    expect(alert.mock.calls[0][1]).toBe(
      "Requests you already sent keep their address. Work becomes your default.",
    );
  });

  it("a refused delete puts the address back and says so, after the sheet closed", async () => {
    const answer = deferred<undefined>();
    jest.mocked(apiDelete).mockReturnValue(answer.promise);
    const { client, view } = openFor("work");
    const { unmount } = await view;

    await fireEvent.press(screen.getByRole("button", { name: "Delete address" }));
    await act(async () => buttons()[1].onPress?.());
    await unmount();
    await act(async () => answer.reject(new ApiError(500, "internal_error")));

    expect(cachedBook(client)).toEqual(["home*", "work"]);
    expect(toastStore.getState().current?.message).toBe(
      "We couldn't delete Work. Try again in a moment.",
    );
  });

  it("closes when its address is not in the book (a stale link)", async () => {
    const { view } = openFor("gone");
    await view;

    expect(router.back).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("address-actions-sheet")).toBeNull();
  });

  it("reads in Spanish", async () => {
    await i18n.changeLanguage("es");
    const { view } = openFor("work");
    await view;

    expect(screen.getByRole("button", { name: "Hacer principal" })).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole("button", { name: "Eliminar dirección" }));
    expect(alert.mock.calls[0][0]).toBe("¿Eliminar Work?");
  });
});
