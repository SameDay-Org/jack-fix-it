import type { QueryClient } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import { router, useLocalSearchParams } from "expo-router";
import { AccessibilityInfo, Alert, type AlertButton } from "react-native";

import { ApiError, apiDelete, apiGet, apiPost, NetworkError } from "@/api";
import { dismissToast, toastStore } from "@/components/ui/toast";
import i18n from "@/i18n";

import { deferred, settle } from "../../../api/__tests__/helpers";
import type { SavedCard, Wallet } from "../cards";
import { PaymentCardSheet } from "../PaymentCardSheet";
import { PaymentMethodsScreen } from "../PaymentMethodsScreen";
import {
  AMEX,
  cachedWallet,
  card,
  CARD_PATH,
  DEFAULT_PATH,
  MASTER,
  newQueryClient,
  renderWallet,
  toast,
  VISA,
  walletClient,
} from "./helpers";

// The session the test is in; a sign-out or another sign-in moves it on.
let mockGeneration = 1;
jest.mock("@/api", () => ({
  ...jest.requireActual("../../../api/errors"),
  apiDelete: jest.fn(),
  apiGet: jest.fn(),
  apiPost: jest.fn(),
  isCurrentGeneration: jest.fn((generation: number) => generation === mockGeneration),
  sessionGeneration: jest.fn(() => mockGeneration),
}));
jest.mock("@/features/payments/paymentSheet", () => ({ openSetupSheet: jest.fn() }));
jest.mock("expo-router", () => ({
  router: { push: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true), replace: jest.fn() },
  useLocalSearchParams: jest.fn(() => ({})),
}));
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);

/** What GET /v1/me/payment-methods answers now. */
let server: Wallet;
const post = jest.mocked(apiPost) as unknown as jest.Mock;
const remove = jest.mocked(apiDelete) as unknown as jest.Mock;
let alert: jest.SpyInstance;
let announce: jest.SpyInstance;

beforeEach(() => {
  mockGeneration = 1;
  server = [VISA, MASTER, AMEX];
  jest
    .mocked(apiGet)
    .mockReset()
    .mockImplementation((async () => server) as never);
  post.mockReset();
  remove.mockReset().mockResolvedValue(undefined);
  jest.mocked(router.back).mockClear();
  alert = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
  // React Native's statics are Jest mocks already: spying again keeps their calls, so clear them.
  announce = jest
    .spyOn(AccessibilityInfo, "announceForAccessibility")
    .mockImplementation(() => undefined);
  announce.mockClear();
  toastStore.setState({ current: null });
});

afterEach(async () => {
  await act(() => settle());
  dismissToast();
  jest.restoreAllMocks();
  await i18n.changeLanguage("en");
});

const openCard = async (id: string, client: QueryClient = walletClient(server)) => {
  jest.mocked(useLocalSearchParams).mockReturnValue({ id });
  const view = await renderWallet(<PaymentCardSheet />, client);
  return { client, view };
};
/** The wallet's screen with a card's sheet over it, on one cache. */
const openBoth = async (id: string) => {
  jest.mocked(useLocalSearchParams).mockReturnValue({ id });
  const client = newQueryClient();
  await renderWallet(
    <>
      <PaymentMethodsScreen />
      <PaymentCardSheet />
    </>,
    client,
  );
  await screen.findByTestId("payment-card-face");
  return client;
};
const buttons = (call = 0) => alert.mock.calls[call][2] as AlertButton[];
const confirmDelete = async () => {
  await fireEvent.press(screen.getByRole("button", { name: "Delete card" }));
  await act(async () => buttons(alert.mock.calls.length - 1)[1].onPress?.());
};
/** The server makes `id` the default and answers with the card, as the API does. */
const serverSetsDefault = (id: string): SavedCard => {
  server = server.map((saved) => ({ ...saved, is_default: saved.id === id }));
  return server.find((saved) => saved.id === id)!;
};

describe("PaymentCardSheet", () => {
  it("opens the card with its data redacted, and offers Set as default and Delete", async () => {
    await openCard("pm_master");

    const face = screen.getByTestId("payment-card-face");
    expect(face.props.accessibilityLabel).toBe("Mastercard ending 4444, expires 03 30");
    expect(face).toHaveTextContent("Mastercard•••• 4444Expires 03/30");
    expect(screen.getByRole("button", { name: "Set as default" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Delete card" })).toBeEnabled();
    expect(screen.queryByTestId("payment-card-is-default")).toBeNull();
    // It read the wallet on screen: nothing was asked for.
    expect(apiGet).not.toHaveBeenCalled();
  });

  it("the default card says it is, and has no Set as default", async () => {
    await openCard("pm_visa");

    expect(screen.getByTestId("payment-card-face").props.accessibilityLabel).toBe(
      "Visa ending 4242, expires 12 28, default",
    );
    expect(screen.getByTestId("card-face-default")).toHaveTextContent("Default");
    expect(screen.getByText("This is your default card.")).toBeOnTheScreen();
    expect(screen.queryByRole("button", { name: "Set as default" })).toBeNull();
    expect(screen.getByRole("button", { name: "Delete card" })).toBeOnTheScreen();
  });

  it("Set as default closes the sheet, shows on the wallet at once and then as the server has it", async () => {
    const answer = deferred<SavedCard>();
    post.mockReturnValue(answer.promise);
    const { client } = await openCard("pm_master");

    await fireEvent.press(screen.getByRole("button", { name: "Set as default" }));

    expect(router.back).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(cachedWallet(client)).toEqual(["pm_visa", "pm_master*", "pm_amex"]));
    expect(post.mock.calls).toEqual([
      [
        DEFAULT_PATH,
        undefined,
        { auth: true, generation: 1, params: { payment_method_id: "pm_master" } },
      ],
    ]);

    await act(async () => answer.resolve(serverSetsDefault("pm_master")));
    await act(() => settle());

    expect(cachedWallet(client)).toEqual(["pm_visa", "pm_master*", "pm_amex"]);
    expect(announce).toHaveBeenCalledWith("Mastercard ending 4444 is now your default");
    expect(toast()).toBeNull();
  });

  it.each([
    [
      new ApiError(500, "internal_error"),
      "We couldn't make Mastercard ending 4444 your default. Try again in a moment.",
    ],
    [
      new ApiError(503, "payments_unavailable"),
      "Cards can't be changed right now. Try again in a moment.",
    ],
    [
      new NetworkError(false),
      "You're offline, so nothing changed. Try again once you're connected.",
    ],
    [new ApiError(429, "rate_limited"), "That's a lot of changes at once. Try again in a moment."],
  ])("a refused default change (case %#) is taken back and said calmly", async (error, message) => {
    const answer = deferred<SavedCard>();
    post.mockReturnValue(answer.promise);
    const { client } = await openCard("pm_master");

    await fireEvent.press(screen.getByRole("button", { name: "Set as default" }));
    await waitFor(() => expect(cachedWallet(client)).toEqual(["pm_visa", "pm_master*", "pm_amex"]));
    await act(async () => answer.reject(error));
    await act(() => settle());

    expect(cachedWallet(client)).toEqual(["pm_visa*", "pm_master", "pm_amex"]);
    expect(toast()).toEqual({ message, tone: "danger" });
    expect(announce).not.toHaveBeenCalled();
  });

  it("a card that is gone when made the default: says so, and the wallet is the server's", async () => {
    post.mockRejectedValue(new ApiError(404, "payment_method_not_found"));
    const client = await openBoth("pm_master");
    // Deleted on another device since the wallet was listed.
    server = [VISA, AMEX];

    await fireEvent.press(screen.getByRole("button", { name: "Set as default" }));
    await act(() => settle());

    expect(toast()).toEqual({
      message: "That card isn't in your wallet anymore.",
      tone: "danger",
    });
    await waitFor(() => expect(cachedWallet(client)).toEqual(["pm_visa*", "pm_amex"]));
  });

  it("Delete asks first, and Cancel deletes nothing", async () => {
    const { client } = await openCard("pm_master");

    await fireEvent.press(screen.getByRole("button", { name: "Delete card" }));

    expect(alert.mock.calls[0][0]).toBe("Delete Mastercard ending 4444?");
    expect(alert.mock.calls[0][1]).toBe("It leaves your wallet for good.");
    expect(buttons().map((button) => [button.text, button.style])).toEqual([
      ["Cancel", "cancel"],
      ["Delete", "destructive"],
    ]);
    await act(async () => buttons()[0].onPress?.());

    expect(remove).not.toHaveBeenCalled();
    expect(router.back).not.toHaveBeenCalled();
    expect(cachedWallet(client)).toEqual(["pm_visa*", "pm_master", "pm_amex"]);
    // A second tap asks again, once.
    await fireEvent.press(screen.getByRole("button", { name: "Delete card" }));
    expect(alert).toHaveBeenCalledTimes(2);
  });

  it("asks once while its question is open", async () => {
    await openCard("pm_master");

    await fireEvent.press(screen.getByRole("button", { name: "Delete card" }));
    await fireEvent.press(screen.getByRole("button", { name: "Delete card" }));

    expect(alert).toHaveBeenCalledTimes(1);
  });

  it("a confirmed delete closes the sheet and takes the card out at once", async () => {
    const answer = deferred<undefined>();
    remove.mockReturnValue(answer.promise);
    const { client } = await openCard("pm_master");

    await confirmDelete();

    expect(router.back).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(cachedWallet(client)).toEqual(["pm_visa*", "pm_amex"]));
    expect(remove.mock.calls).toEqual([
      [
        CARD_PATH,
        undefined,
        { auth: true, generation: 1, params: { payment_method_id: "pm_master" } },
      ],
    ]);

    server = [VISA, AMEX];
    await act(async () => answer.resolve(undefined));
    await act(() => settle());

    expect(cachedWallet(client)).toEqual(["pm_visa*", "pm_amex"]);
    expect(announce).toHaveBeenCalledWith("Mastercard ending 4444 deleted");
  });

  it("deleting the default says another card takes over, and names none", async () => {
    await openCard("pm_visa");

    await fireEvent.press(screen.getByRole("button", { name: "Delete card" }));

    expect(alert.mock.calls[0][1]).toBe(
      "It leaves your wallet for good. Another card becomes your default.",
    );
  });

  it("deleting the only card promises no next default", async () => {
    server = [VISA];
    await openCard("pm_visa");

    await fireEvent.press(screen.getByRole("button", { name: "Delete card" }));

    expect(alert.mock.calls[0][1]).toBe("It leaves your wallet for good.");
  });

  it.each([
    [
      new ApiError(500, "internal_error"),
      "We couldn't delete Mastercard ending 4444. Try again in a moment.",
    ],
    [
      new ApiError(503, "payments_unavailable"),
      "Cards can't be changed right now. Try again in a moment.",
    ],
    [
      new NetworkError(false),
      "You're offline, so nothing changed. Try again once you're connected.",
    ],
  ])("a refused delete (case %#) puts the card back and says so", async (error, message) => {
    const answer = deferred<undefined>();
    remove.mockReturnValue(answer.promise);
    const { client } = await openCard("pm_master");

    await confirmDelete();
    await waitFor(() => expect(cachedWallet(client)).toEqual(["pm_visa*", "pm_amex"]));
    await act(async () => answer.reject(error));
    await act(() => settle());

    expect(cachedWallet(client)).toEqual(["pm_visa*", "pm_master", "pm_amex"]);
    expect(toast()).toEqual({ message, tone: "danger" });
    expect(announce).not.toHaveBeenCalled();
  });

  it("a card already gone counts as deleted", async () => {
    remove.mockRejectedValue(new ApiError(404, "payment_method_not_found"));
    const { client } = await openCard("pm_master");

    await confirmDelete();
    await act(() => settle());

    expect(cachedWallet(client)).toEqual(["pm_visa*", "pm_amex"]);
    expect(toast()).toBeNull();
    expect(announce).toHaveBeenCalledWith("Mastercard ending 4444 deleted");
  });

  it("a refusal does not draw over a wallet the server listed meanwhile", async () => {
    const answer = deferred<undefined>();
    remove.mockReturnValue(answer.promise);
    const { client } = await openCard("pm_master");

    await confirmDelete();
    await waitFor(() => expect(cachedWallet(client)).toEqual(["pm_visa*", "pm_amex"]));
    // A list lands while the delete is unanswered: another device removed Amex.
    await act(async () => client.setQueryData(["payment-methods"], [VISA, MASTER]));
    await act(async () => answer.reject(new ApiError(500, "internal_error")));
    await act(() => settle());

    expect(cachedWallet(client)).toEqual(["pm_visa*", "pm_master"]);
  });

  it("a stale link, to a card the wallet does not have, backs out once", async () => {
    await openCard("pm_gone");

    expect(screen.queryByTestId("payment-card-sheet")).toBeNull();
    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it("opened by a link before the wallet loaded, it fetches the wallet", async () => {
    await openCard("pm_master", newQueryClient());

    expect(await screen.findByTestId("payment-card-face")).toBeOnTheScreen();
    expect(apiGet).toHaveBeenCalledTimes(1);
  });

  it("backs out when the wallet cannot load", async () => {
    jest.mocked(apiGet).mockRejectedValue(new NetworkError(false));
    await openCard("pm_master", newQueryClient());

    await waitFor(() => expect(router.back).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("payment-card-sheet")).toBeNull();
  });

  it("keeps showing its card while the sheet closes over the change it asked for", async () => {
    await openCard("pm_master");
    remove.mockReturnValue(deferred<undefined>().promise);

    await confirmDelete();

    // The card left the wallet, not the closing sheet; and the sheet backs out once.
    expect(screen.getByTestId("payment-card-face")).toBeOnTheScreen();
    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it("reads in Spanish", async () => {
    await i18n.changeLanguage("es");
    await openCard("pm_master");

    expect(screen.getByTestId("payment-card-face").props.accessibilityLabel).toBe(
      "Mastercard terminada en 4444, vence 03 30",
    );
    expect(screen.getByRole("button", { name: "Hacer predeterminada" })).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole("button", { name: "Eliminar tarjeta" }));
    expect(alert.mock.calls[0][0]).toBe("¿Eliminar Mastercard terminada en 4444?");
  });
});

describe("one change of the wallet at a time", () => {
  it("while a change is unanswered, the sheet's actions and Add wait", async () => {
    const answer = deferred<SavedCard>();
    post.mockReturnValue(answer.promise);
    const client = await openBoth("pm_master");

    await fireEvent.press(screen.getByRole("button", { name: "Set as default" }));
    await waitFor(() => expect(cachedWallet(client)).toEqual(["pm_visa", "pm_master*", "pm_amex"]));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Set as default" })).toBeDisabled(),
    );
    expect(screen.getByRole("button", { name: "Delete card" })).toBeDisabled();
    expect(screen.getByTestId("payment-methods-add")).toBeDisabled();
    // Pressed anyway: nothing more is sent.
    await fireEvent.press(screen.getByRole("button", { name: "Set as default" }));
    await fireEvent.press(screen.getByRole("button", { name: "Delete card" }));
    await fireEvent.press(screen.getByTestId("payment-methods-add"));
    expect(post).toHaveBeenCalledTimes(1);
    expect(alert).not.toHaveBeenCalled();

    await act(async () => answer.resolve(serverSetsDefault("pm_master")));
    await act(() => settle());

    expect(screen.getByRole("button", { name: "Delete card" })).toBeEnabled();
    expect(screen.getByTestId("payment-methods-add")).toBeEnabled();
  });

  it("a delete confirmed while another change started is not sent, and the sheet stays", async () => {
    const answer = deferred<SavedCard>();
    post.mockReturnValue(answer.promise);
    const client = await openBoth("pm_master");

    // The question opens first; the default change starts while it is still up.
    await fireEvent.press(screen.getByRole("button", { name: "Delete card" }));
    await fireEvent.press(screen.getByRole("button", { name: "Set as default" }));
    await waitFor(() => expect(cachedWallet(client)).toEqual(["pm_visa", "pm_master*", "pm_amex"]));
    jest.mocked(router.back).mockClear();
    await act(async () => buttons()[1].onPress?.());

    expect(remove).not.toHaveBeenCalled();
    expect(router.back).not.toHaveBeenCalled();
    await act(async () => answer.resolve(serverSetsDefault("pm_master")));
  });

  it("deleting the default: the pocket waits for the server to name the next one", async () => {
    const answer = deferred<undefined>();
    remove.mockReturnValue(answer.promise);
    await openBoth("pm_visa");

    await confirmDelete();

    // No card is crowned on the device: the pocket says the wallet is updating.
    expect(await screen.findByTestId("wallet-pocket-none")).toHaveTextContent(
      "Updating your wallet…",
    );
    // The server promotes the most recently added of the others, whatever the device would guess.
    server = [MASTER, { ...AMEX, is_default: true }];
    await act(async () => answer.resolve(undefined));

    expect(await screen.findByTestId("wallet-pocket-default")).toHaveTextContent(
      "DefaultAmerican Express •••• 0005",
    );
    expect(screen.queryByTestId("wallet-card-pm_visa")).toBeNull();
  });
});

describe("a change belongs to the session it was asked in", () => {
  /** A sign-out, then another account: the cache is cleared and holds that account's wallet. */
  const nextSession = async (client: QueryClient) => {
    const other = [card({ id: "pm_other", is_default: true })];
    await act(async () => {
      mockGeneration = 2;
      server = other;
      client.clear();
      client.setQueryData(["payment-methods"], other);
    });
  };

  it("a default change answered after the session changed touches nothing", async () => {
    const answer = deferred<SavedCard>();
    post.mockReturnValue(answer.promise);
    const { client } = await openCard("pm_master");

    await fireEvent.press(screen.getByRole("button", { name: "Set as default" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    await nextSession(client);
    const listed = jest.mocked(apiGet).mock.calls.length;
    await act(async () => answer.resolve({ ...MASTER, is_default: true }));
    await act(() => settle());

    expect(cachedWallet(client)).toEqual(["pm_other*"]);
    expect(announce).not.toHaveBeenCalled();
    expect(jest.mocked(apiGet).mock.calls).toHaveLength(listed);
  });

  it("a delete refused after the session changed puts nothing back and shows nothing", async () => {
    const answer = deferred<undefined>();
    remove.mockReturnValue(answer.promise);
    const { client } = await openCard("pm_master");

    await confirmDelete();
    await waitFor(() => expect(remove).toHaveBeenCalledTimes(1));
    await nextSession(client);
    await act(async () => answer.reject(new ApiError(500, "internal_error")));
    await act(() => settle());

    expect(cachedWallet(client)).toEqual(["pm_other*"]);
    expect(toast()).toBeNull();
  });
});
