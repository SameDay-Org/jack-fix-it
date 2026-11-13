import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, renderHook, screen, waitFor } from "@testing-library/react-native";
import { router, useLocalSearchParams } from "expo-router";
import { createElement, type ReactNode } from "react";
import { Alert, type AlertButton, type AlertOptions } from "react-native";

import { ApiError, apiDelete, apiGet, apiPatch, apiPost, NetworkError, useSession } from "@/api";
import { dismissToast, toastStore } from "@/components/ui/toast";
import i18n from "@/i18n";

import { deferred, settle } from "../../../api/__tests__/helpers";
import { signedIn } from "../../home/__tests__/helpers";
import { AddressActionsSheet } from "../AddressActionsSheet";
import { SAVED_ADDRESSES_QUERY_KEY, useCreateAddress, type SavedAddress } from "../api";
import {
  bookClient,
  cachedBook,
  CABIN,
  HOME,
  newQueryClient,
  renderAddresses,
  WORK,
} from "./helpers";

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

  // The Gatekeeper's round 1 sequence (PR #354). Its probe expected "Home becomes your default"
  // from the book as the device drew it, which it cannot know: addresses carry no creation date.
  it("after a default change the server has not listed yet, promises no particular new default", async () => {
    // Created oldest to newest: Home, Work, Mom. Mom is the default, so the API lists Mom, Home, Work.
    const mom = { ...CABIN, id: "mom", label: "Mom", is_default: true };
    const home = { ...HOME, is_default: false };
    const answer = deferred<typeof WORK>();
    jest.mocked(apiPatch).mockReturnValue(answer.promise);
    const client = bookClient([mom, home, WORK]);
    const first = await openFor("work", client).view;
    await fireEvent.press(screen.getByRole("button", { name: "Make default" }));
    await first.unmount();
    expect(cachedBook(client)).toEqual(["work*", "mom", "home"]);

    // Work's menu again, before the server lists the book. The device draws Mom next, but the API
    // promotes the oldest address left, Home: the device cannot tell, so it names no one.
    const second = await openFor("work", client).view;
    await fireEvent.press(screen.getByRole("button", { name: "Delete address" }));
    expect(alert.mock.calls[0][1]).toBe(
      "Requests you already sent keep their address. Another address becomes your default.",
    );

    // The server answers, then lists the book: Work, and the others oldest first.
    await act(async () => answer.resolve({ ...WORK, is_default: true }));
    await act(async () => {
      await client.fetchQuery({
        queryKey: SAVED_ADDRESSES_QUERY_KEY,
        queryFn: async () => ({
          items: [{ ...WORK, is_default: true }, home, { ...mom, is_default: false }],
        }),
      });
    });
    // The sheet already open keeps the book it was opened with: it still names no one.
    await act(async () => buttons()[0].onPress?.());
    await fireEvent.press(screen.getByRole("button", { name: "Delete address" }));
    expect(alert.mock.calls[1][1]).toBe(
      "Requests you already sent keep their address. Another address becomes your default.",
    );
    await second.unmount();

    // One opened now reads the server's list, and names Home as the server will.
    await openFor("work", client).view;
    await fireEvent.press(screen.getByRole("button", { name: "Delete address" }));
    expect(alert.mock.calls[2][1]).toBe(
      "Requests you already sent keep their address. Home becomes your default.",
    );
  });

  it("with one other address, names it once the change that left it there is answered", async () => {
    const answer = deferred<typeof WORK>();
    jest.mocked(apiPatch).mockReturnValue(answer.promise);
    const client = bookClient([HOME, WORK]);
    const first = await openFor("work", client).view;
    await fireEvent.press(screen.getByRole("button", { name: "Make default" }));
    await first.unmount();

    // Unanswered: refused, Work would not be the default, and deleting it would move no one.
    const second = await openFor("work", client).view;
    await fireEvent.press(screen.getByRole("button", { name: "Delete address" }));
    expect(alert.mock.calls[0][1]).toBe(
      "Requests you already sent keep their address. Another address becomes your default.",
    );
    await second.unmount();

    await act(async () => answer.resolve({ ...WORK, is_default: true }));
    await openFor("work", client).view;
    await fireEvent.press(screen.getByRole("button", { name: "Delete address" }));
    expect(alert.mock.calls[1][1]).toBe(
      "Requests you already sent keep their address. Home becomes your default.",
    );
  });

  it("names no one while a delete that left one other address is unanswered", async () => {
    const deleted = deferred<undefined>();
    jest.mocked(apiDelete).mockReturnValue(deleted.promise);
    const client = bookClient([HOME, WORK, CABIN]);
    const first = await openFor("work", client).view;
    await fireEvent.press(screen.getByRole("button", { name: "Delete address" }));
    await act(async () => buttons()[1].onPress?.());
    await first.unmount();
    expect(cachedBook(client)).toEqual(["home*", "cabin"]);

    // Refused, Work comes back, and the API would promote it (the oldest), not Cabin.
    await openFor("home", client).view;
    await fireEvent.press(screen.getByRole("button", { name: "Delete address" }));
    expect(alert.mock.calls[1][1]).toBe(
      "Requests you already sent keep their address. Another address becomes your default.",
    );
    await act(async () => deleted.reject(new ApiError(500, "internal_error")));
    expect(cachedBook(client)).toEqual(["home*", "work", "cabin"]);
  });

  it("after two addresses were added together, names neither as the next default", async () => {
    // Work and Cabin were saved from two forms, the second before the first was answered. The
    // server took them in an order their answers do not say, and no list came after.
    jest.mocked(apiGet).mockRejectedValue(new NetworkError(false));
    const answers = [deferred<SavedAddress>(), deferred<SavedAddress>()];
    jest
      .mocked(apiPost)
      .mockReturnValueOnce(answers[0].promise)
      .mockReturnValueOnce(answers[1].promise);
    const client = bookClient([HOME]);
    const { result } = await renderHook(() => useCreateAddress(), {
      wrapper: ({ children }: { children: ReactNode }) =>
        createElement(QueryClientProvider, { client }, children),
    });
    const bodyOf = (address: SavedAddress) => ({
      line1: address.line1,
      city: address.city,
      state: address.state,
      zip_code: address.zip_code,
      label: address.label,
      is_default: false,
    });
    await act(async () => result.current.mutate({ body: bodyOf(WORK), generation: 1 }));
    await act(async () => result.current.mutate({ body: bodyOf(CABIN), generation: 1 }));
    await act(async () => answers[0].resolve(WORK));
    await act(async () => answers[1].resolve(CABIN));
    expect(cachedBook(client)).toEqual(["home*", "work", "cabin"]);

    // Work is drawn next, but Cabin may be the older one: the device names no one.
    await openFor("home", client).view;
    await fireEvent.press(screen.getByRole("button", { name: "Delete address" }));
    expect(alert.mock.calls[0][1]).toBe(
      "Requests you already sent keep their address. Another address becomes your default.",
    );
  });

  it("says in Spanish that another address becomes the default", async () => {
    await i18n.changeLanguage("es");
    const client = newQueryClient();
    client.setQueryData(SAVED_ADDRESSES_QUERY_KEY, { items: [HOME, WORK, CABIN], guessed: true });
    await openFor("home", client).view;

    await fireEvent.press(screen.getByRole("button", { name: "Eliminar dirección" }));

    expect(alert.mock.calls[0][1]).toBe(
      "Las solicitudes que ya enviaste conservan su dirección. Otra de tus direcciones pasa a ser la principal.",
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

  it("opened by a link before the book loaded, waits for it, then shows the address", async () => {
    const answer = deferred<{ items: (typeof HOME)[] }>();
    jest.mocked(apiGet).mockReturnValue(answer.promise);
    const { view } = openFor("work", newQueryClient());
    await view;

    expect(screen.queryByTestId("address-actions-sheet")).toBeNull();
    expect(router.back).not.toHaveBeenCalled();
    await act(async () => answer.resolve({ items: [HOME, WORK] }));

    expect(await screen.findByRole("button", { name: "Make default" })).toBeOnTheScreen();
    expect(router.back).not.toHaveBeenCalled();
  });

  it("closes when the book it waited for could not load", async () => {
    jest.mocked(apiGet).mockRejectedValue(new NetworkError(false));
    const { view } = openFor("work", newQueryClient());
    await view;

    await waitFor(() => expect(router.back).toHaveBeenCalledTimes(1));
  });

  it("asks nothing when the book is already on screen", async () => {
    const { view } = openFor("work");
    await view;

    expect(apiGet).not.toHaveBeenCalled();
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
