import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, fireEvent, renderHook, screen, waitFor } from "@testing-library/react-native";
import { router, useLocalSearchParams } from "expo-router";
import type { ReactNode } from "react";
import { AccessibilityInfo, Alert, StyleSheet, type AlertButton } from "react-native";

import { ApiError, apiDelete, apiGet, apiPost, NetworkError } from "@/api";
import { dismissToast, toastStore } from "@/components/ui/toast";
import { openSetupSheet } from "@/features/payments/paymentSheet";
import i18n from "@/i18n";

import { deferred, settle } from "../../../api/__tests__/helpers";
import { PAYMENT_METHODS_QUERY_KEY, useAddCard, useDeleteCard, useSetDefaultCard } from "../api";
import type { SavedCard, Wallet } from "../cards";
import { PaymentCardSheet } from "../PaymentCardSheet";
import { PaymentMethodsScreen } from "../PaymentMethodsScreen";
import {
  AMEX,
  cachedWallet,
  card,
  CARD_PATH,
  DEFAULT_PATH,
  DISCOVER,
  MASTER,
  newQueryClient,
  renderWallet,
  SETUP,
  SETUP_PATH,
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
  // The router is idle: a card opens on its first tap (a test that taps twice says otherwise).
  unstable_useIsNavigating: jest.fn(() => false),
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
const sheet = jest.mocked(openSetupSheet);
const postsTo = (path: string) => post.mock.calls.filter(([asked]) => asked === path);
let alert: jest.SpyInstance;
let announce: jest.SpyInstance;

/** What a set default or delete with no answer says: the app cannot tell whether it went through. */
const UNCONFIRMED =
  "We couldn't confirm that change. Check your connection, then open your cards again to see where things stand.";

beforeEach(() => {
  mockGeneration = 1;
  server = [VISA, MASTER, AMEX];
  jest
    .mocked(apiGet)
    .mockReset()
    .mockImplementation((async () => server) as never);
  post.mockReset();
  remove.mockReset().mockResolvedValue(undefined);
  // An add that reaches Stripe's sheet ends with the customer closing it.
  sheet.mockReset().mockResolvedValue({ kind: "canceled" });
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
/** The wallet's hooks on their own, on one cache: the actions without a button in front of them. */
const withClient = (client: QueryClient) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
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

  it("the card right behind the front one opens in its strip's tone, which is not the front card's", async () => {
    // Four cards, the oldest (Visa) still the default: by its age alone Discover, the newest and
    // right behind Visa in the pocket, would take Visa's tone.
    server = [DISCOVER, AMEX, MASTER, VISA];
    await openBoth("pm_discover");
    const surface = (testID: string): unknown =>
      StyleSheet.flatten(screen.getByTestId(testID).props.style).backgroundColor;

    expect(surface("wallet-card-pm_discover")).not.toBe(surface("wallet-card-pm_visa"));
    expect(surface("payment-card-face")).toBe(surface("wallet-card-pm_discover"));
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
    [new NetworkError(false), UNCONFIRMED],
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

  it("a default change that timed out never says nothing changed, and the wallet ends as the server has it", async () => {
    const answer = deferred<SavedCard>();
    post.mockReturnValue(answer.promise);
    const client = await openBoth("pm_master");

    await fireEvent.press(screen.getByRole("button", { name: "Set as default" }));
    await waitFor(() => expect(cachedWallet(client)).toEqual(["pm_visa", "pm_master*", "pm_amex"]));
    // The server made the change; its answer came after the app's timeout.
    serverSetsDefault("pm_master");
    await act(async () => answer.reject(new NetworkError(true)));
    await act(() => settle());

    expect(toast()).toEqual({ message: UNCONFIRMED, tone: "danger" });
    expect(toast()?.message).not.toMatch(/nothing changed/i);
    await waitFor(() => expect(cachedWallet(client)).toEqual(["pm_visa", "pm_master*", "pm_amex"]));
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
    [new NetworkError(false), UNCONFIRMED],
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

  it("a delete that timed out never says nothing changed, and the wallet ends as the server has it", async () => {
    const answer = deferred<undefined>();
    remove.mockReturnValue(answer.promise);
    const client = await openBoth("pm_master");

    await confirmDelete();
    await waitFor(() => expect(cachedWallet(client)).toEqual(["pm_visa*", "pm_amex"]));
    // Stripe detached the card; the answer came after the app's timeout.
    server = [VISA, AMEX];
    await act(async () => answer.reject(new NetworkError(true)));
    await act(() => settle());

    expect(toast()).toEqual({ message: UNCONFIRMED, tone: "danger" });
    expect(toast()?.message).not.toMatch(/nothing changed/i);
    await waitFor(() => expect(cachedWallet(client)).toEqual(["pm_visa*", "pm_amex"]));
    expect(screen.queryByTestId("wallet-card-pm_master")).toBeNull();
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
    expect(screen.getByRole("button", { name: "Usar por defecto" })).toBeOnTheScreen();
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

    // The wallet's Add is back; the sheet acted, so its actions stay off while it closes.
    expect(screen.getByTestId("payment-methods-add")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Delete card" })).toBeDisabled();
    await fireEvent.press(screen.getByRole("button", { name: "Delete card" }));
    expect(alert).not.toHaveBeenCalled();
  });

  it("a delete confirmed while another change started is not sent, and the sheet stays", async () => {
    const setup = deferred<typeof SETUP>();
    post.mockReturnValue(setup.promise);
    await openBoth("pm_master");

    // The question opens first; an add starts on the wallet's screen while it is still up. The
    // sheet itself has not closed, so a close now could only come from the confirmed delete.
    await fireEvent.press(screen.getByRole("button", { name: "Delete card" }));
    await fireEvent.press(screen.getByTestId("payment-methods-add"));
    await waitFor(() => expect(postsTo(SETUP_PATH)).toHaveLength(1));
    try {
      await act(async () => buttons()[1].onPress?.());

      expect(remove).not.toHaveBeenCalled();
      expect(router.back).not.toHaveBeenCalled();
      expect(screen.getByTestId("payment-card-sheet")).toBeOnTheScreen();
    } finally {
      // The add ends, the customer closing Stripe's sheet: the app's one sheet is free again for
      // the next test, whatever failed here.
      await act(async () => setup.resolve({ ...SETUP }));
      await act(() => settle());
    }
    expect(sheet).toHaveBeenCalledTimes(1);
  });

  it("deleting the default: the pocket waits for the server to name the next one", async () => {
    const answer = deferred<undefined>();
    remove.mockReturnValue(answer.promise);
    await openBoth("pm_visa");

    await confirmDelete();

    // No card is crowned on the device: the pocket says the wallet is updating.
    expect(await screen.findByTestId("wallet-pocket-updating")).toHaveTextContent(
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

  it("deleting the default: a list that then fails never says there is no default, and Try again shows the server's", async () => {
    const answer = deferred<undefined>();
    remove.mockReturnValue(answer.promise);
    await openBoth("pm_visa");

    await confirmDelete();
    expect(await screen.findByTestId("wallet-pocket-updating")).toBeOnTheScreen();
    // The server deleted Visa and promoted Amex, but the list asked afterwards gets no answer.
    server = [MASTER, { ...AMEX, is_default: true }];
    jest.mocked(apiGet).mockRejectedValueOnce(new NetworkError(false));
    await act(async () => answer.resolve(undefined));
    await act(() => settle());

    // No claim either way about the default, and the screen says the wallet may be out of date.
    expect(await screen.findByTestId("wallet-pocket-stale")).toHaveTextContent(
      "Couldn't check your default card",
    );
    expect(screen.queryByTestId("wallet-pocket-none")).toBeNull();
    expect(screen.queryByText("No default card")).toBeNull();
    expect(screen.getByTestId("payment-methods-stale")).toHaveTextContent(
      "We couldn't refresh your cards. What you see may be out of date.",
      { exact: false },
    );
    expect(screen.getByTestId("payment-methods-refresh")).toHaveTextContent("Try again");
    expect(screen.queryByTestId("payment-methods-failed")).toBeNull();

    await fireEvent.press(screen.getByTestId("payment-methods-refresh"));

    expect(await screen.findByTestId("wallet-pocket-default")).toHaveTextContent(
      "DefaultAmerican Express •••• 0005",
    );
    expect(screen.queryByTestId("payment-methods-stale")).toBeNull();
    expect(screen.queryByTestId("wallet-pocket-stale")).toBeNull();
  });

  it("the empty pocket's Add is off while the delete that emptied it is unanswered", async () => {
    server = [VISA];
    const answer = deferred<undefined>();
    remove.mockReturnValue(answer.promise);
    const client = await openBoth("pm_visa");

    await confirmDelete();

    // The only card left at once: the pocket is the Add button, and it waits for the server.
    const pocket = await screen.findByTestId("wallet-pocket-add");
    expect(pocket).toBeDisabled();
    expect(pocket).toHaveStyle({ opacity: 0.5 });
    await fireEvent.press(pocket);
    expect(postsTo(SETUP_PATH)).toEqual([]);

    server = [];
    await act(async () => answer.resolve(undefined));
    await act(() => settle());

    expect(cachedWallet(client)).toEqual([]);
    await waitFor(() => expect(screen.getByTestId("wallet-pocket-add")).toBeEnabled());
    expect(screen.getByTestId("wallet-pocket-add")).not.toHaveStyle({ opacity: 0.5 });
    // Now a tap starts the add.
    post.mockResolvedValue({ ...SETUP });
    await fireEvent.press(screen.getByTestId("wallet-pocket-add"));
    await act(() => settle());
    expect(postsTo(SETUP_PATH)).toHaveLength(1);
    expect(sheet).toHaveBeenCalledTimes(1);
  });

  it("the actions themselves refuse a second change while one is unanswered, buttons aside", async () => {
    const answer = deferred<SavedCard>();
    post.mockReturnValueOnce(answer.promise);
    const client = walletClient(server);
    const { result } = await renderHook(
      () => ({
        setDefault: useSetDefaultCard(),
        deleteCard: useDeleteCard(),
        addCard: useAddCard(),
      }),
      { wrapper: withClient(client) },
    );

    const first = await act(async () => result.current.setDefault(MASTER));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const refused = await act(async () => {
      const started = [result.current.setDefault(AMEX), result.current.deleteCard(AMEX)];
      result.current.addCard.add();
      return started;
    });
    await act(() => settle());

    expect(first).toBe(true);
    expect(refused).toEqual([false, false]);
    expect(post.mock.calls.map(([path, , options]) => [path, options.params])).toEqual([
      [DEFAULT_PATH, { payment_method_id: "pm_master" }],
    ]);
    expect(remove).not.toHaveBeenCalled();
    expect(sheet).not.toHaveBeenCalled();

    // Once the first is answered, the next one starts.
    await act(async () => answer.resolve(serverSetsDefault("pm_master")));
    await act(() => settle());
    post.mockImplementation(async () => serverSetsDefault("pm_amex"));
    const next = await act(async () => result.current.setDefault(AMEX));
    await act(() => settle());

    expect(next).toBe(true);
    expect(postsTo(DEFAULT_PATH).map(([, , options]) => options.params)).toEqual([
      { payment_method_id: "pm_master" },
      { payment_method_id: "pm_amex" },
    ]);
    expect(cachedWallet(client)).toEqual(["pm_visa", "pm_master", "pm_amex*"]);
  });
});

describe("an open sheet follows the wallet until it acts", () => {
  /**
   * The wallet's screen with a card's sheet over it, on one cache. `openNext(id)` taps another card
   * on the wallet, and the sheet the router opens for it takes the place of the one before (that
   * one closed over its own change).
   */
  const openOnWallet = async (id: string) => {
    let sheets = 0;
    const tree = () => (
      <>
        <PaymentMethodsScreen />
        <PaymentCardSheet key={sheets} />
      </>
    );
    jest.mocked(useLocalSearchParams).mockReturnValue({ id });
    const client = newQueryClient();
    const view = await renderWallet(tree(), client);
    await screen.findByTestId("payment-card-face");
    const openNext = async (next: string) => {
      jest.mocked(router.push).mockClear();
      await fireEvent.press(screen.getByTestId(`wallet-card-${next}`));
      expect(router.push).toHaveBeenCalledWith({
        pathname: "/account/payment-methods/[id]",
        params: { id: next },
      });
      jest.mocked(useLocalSearchParams).mockReturnValue({ id: next });
      sheets += 1;
      await view.rerender(tree());
    };
    return { client, openNext };
  };
  /** What the open sheet says of its card: the default line, Set as default, the face's label. */
  const sheetSays = () => ({
    isDefault: screen.queryByTestId("payment-card-is-default") !== null,
    offersSetDefault: screen.queryByRole("button", { name: "Set as default" }) !== null,
    spoken: screen.getByTestId("payment-card-face").props.accessibilityLabel as string,
  });

  it("opened while the default's delete is unanswered, it shows the server's new default as its card", async () => {
    const answer = deferred<undefined>();
    remove.mockReturnValue(answer.promise);
    const { client, openNext } = await openOnWallet("pm_visa");
    await confirmDelete();
    await waitFor(() => expect(cachedWallet(client)).toEqual(["pm_master", "pm_amex"]));

    // Amex opens on the wallet the delete drew: no card is the default there.
    await openNext("pm_amex");
    expect(sheetSays()).toEqual({
      isDefault: false,
      offersSetDefault: true,
      spoken: "American Express ending 0005, expires 07 27",
    });

    // The server deleted Visa and made Amex the default; the list asked afterwards says so.
    server = [MASTER, { ...AMEX, is_default: true }];
    await act(async () => answer.resolve(undefined));
    await act(() => settle());
    await waitFor(() => expect(cachedWallet(client)).toEqual(["pm_master", "pm_amex*"]));

    expect(screen.getByTestId("payment-card-is-default")).toHaveTextContent(
      "This is your default card.",
    );
    expect(screen.queryByRole("button", { name: "Set as default" })).toBeNull();
    expect(screen.getByTestId("payment-card-face").props.accessibilityLabel).toBe(
      "American Express ending 0005, expires 07 27, default",
    );
    // Deleting it now says the default moves on, as Visa's did.
    await fireEvent.press(screen.getByRole("button", { name: "Delete card" }));
    expect(alert.mock.calls.map(([title, body]) => [title, body])).toEqual([
      [
        "Delete Visa ending 4242?",
        "It leaves your wallet for good. Another card becomes your default.",
      ],
      [
        "Delete American Express ending 0005?",
        "It leaves your wallet for good. Another card becomes your default.",
      ],
    ]);
  });

  it.each([
    [
      // The card the change named: the default on the wallet while it is unanswered.
      "pm_master",
      {
        isDefault: true,
        offersSetDefault: false,
        spoken: "Mastercard ending 4444, expires 03 30, default",
      },
      { isDefault: false, offersSetDefault: true, spoken: "Mastercard ending 4444, expires 03 30" },
    ],
    [
      // The default it took the mark from.
      "pm_visa",
      { isDefault: false, offersSetDefault: true, spoken: "Visa ending 4242, expires 12 28" },
      {
        isDefault: true,
        offersSetDefault: false,
        spoken: "Visa ending 4242, expires 12 28, default",
      },
    ],
  ])(
    "opened while a default change is unanswered, it follows the wallet when the change is refused (%s)",
    async (id, unanswered, refused) => {
      const answer = deferred<SavedCard>();
      post.mockReturnValue(answer.promise);
      const { client, openNext } = await openOnWallet("pm_master");
      await fireEvent.press(screen.getByRole("button", { name: "Set as default" }));
      await waitFor(() =>
        expect(cachedWallet(client)).toEqual(["pm_visa", "pm_master*", "pm_amex"]),
      );

      await openNext(id);
      expect(sheetSays()).toEqual(unanswered);

      // The list asked afterwards is still on its way: the wallet is the change taken back.
      jest.mocked(apiGet).mockReturnValueOnce(deferred<Wallet>().promise as never);
      await act(async () => answer.reject(new ApiError(500, "internal_error")));
      await act(() => settle());

      expect(cachedWallet(client)).toEqual(["pm_visa*", "pm_master", "pm_amex"]);
      expect(sheetSays()).toEqual(refused);
    },
  );

  it("once Set as default is pressed it holds what it showed while it closes, whatever lands in the wallet", async () => {
    const answer = deferred<SavedCard>();
    post.mockReturnValue(answer.promise);
    const client = await openBoth("pm_master");
    const shown = sheetSays();
    expect(shown).toEqual({
      isDefault: false,
      offersSetDefault: true,
      spoken: "Mastercard ending 4444, expires 03 30",
    });

    await fireEvent.press(screen.getByRole("button", { name: "Set as default" }));
    // The change is drawn on the wallet at once, under the closing sheet...
    await waitFor(() => expect(cachedWallet(client)).toEqual(["pm_visa", "pm_master*", "pm_amex"]));
    expect(screen.getByTestId("wallet-pocket-default")).toHaveTextContent(
      "DefaultMastercard •••• 4444",
    );
    expect(sheetSays()).toEqual(shown);

    // ...then the server's answer and the list asked afterwards land.
    await act(async () => answer.resolve(serverSetsDefault("pm_master")));
    await act(() => settle());

    expect(cachedWallet(client)).toEqual(["pm_visa", "pm_master*", "pm_amex"]);
    expect(sheetSays()).toEqual(shown);
    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it("once a delete is confirmed it holds what it showed too, when the card comes back as the default", async () => {
    const answer = deferred<undefined>();
    remove.mockReturnValue(answer.promise);
    const client = await openBoth("pm_master");
    const shown = sheetSays();

    await confirmDelete();
    await waitFor(() => expect(cachedWallet(client)).toEqual(["pm_visa*", "pm_amex"]));
    // Another device made Mastercard the default meanwhile, and this delete is refused.
    serverSetsDefault("pm_master");
    await act(async () => answer.reject(new ApiError(500, "internal_error")));
    await act(() => settle());

    await waitFor(() => expect(cachedWallet(client)).toEqual(["pm_visa", "pm_master*", "pm_amex"]));
    expect(sheetSays()).toEqual(shown);
    expect(router.back).toHaveBeenCalledTimes(1);
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
    await act(async () => answer.resolve({ ...MASTER, is_default: true }));
    await act(() => settle());

    expect(cachedWallet(client)).toEqual(["pm_other*"]);
    expect(announce).not.toHaveBeenCalled();
    // The new session's wallet is not listed again for it: a list asked for would mark it, even
    // with no screen here to fetch it.
    expect(client.getQueryState(PAYMENT_METHODS_QUERY_KEY)?.isInvalidated).toBe(false);
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
    expect(client.getQueryState(PAYMENT_METHODS_QUERY_KEY)?.isInvalidated).toBe(false);
  });
});
