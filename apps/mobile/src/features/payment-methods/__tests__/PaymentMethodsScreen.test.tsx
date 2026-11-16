import type { QueryClient } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react-native";
import { router } from "expo-router";

import { ApiError, apiGet, apiPost, NetworkError } from "@/api";
import { dismissToast, toastStore } from "@/components/ui/toast";
import { openSetupSheet } from "@/features/payments/paymentSheet";
import i18n from "@/i18n";

import { deferred, settle } from "../../../api/__tests__/helpers";
import type { Wallet } from "../cards";
import { PaymentMethodsScreen } from "../PaymentMethodsScreen";
import {
  AMEX,
  cachedWallet,
  card,
  DEFAULT_PATH,
  DISCOVER,
  JCB,
  MASTER,
  NEW,
  newQueryClient,
  renderWallet,
  SECRETS,
  SETUP,
  SETUP_PATH,
  toast,
  VISA,
  WALLET_PATH,
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
// Stripe's sheet, at the wallet's edge of it: how it ends is what the wallet acts on.
jest.mock("@/features/payments/paymentSheet", () => ({ openSetupSheet: jest.fn() }));
jest.mock("expo-router", () => ({
  router: { push: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true), replace: jest.fn() },
}));
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);

/** What GET /v1/me/payment-methods answers now. */
let server: Wallet;
const post = jest.mocked(apiPost) as unknown as jest.Mock;
const sheet = jest.mocked(openSetupSheet);

/** The API as it behaves: a SetupIntent per ask, and a default call that moves the default. */
const answerPosts = () =>
  post.mockImplementation(async (path: string, _body: unknown, options: unknown) => {
    if (path === SETUP_PATH) return { ...SETUP };
    if (path !== DEFAULT_PATH) throw new Error(`unexpected ${path}`);
    const id = (options as { params: { payment_method_id: string } }).params.payment_method_id;
    server = server.map((saved) => ({ ...saved, is_default: saved.id === id }));
    return server.find((saved) => saved.id === id);
  });
const postsTo = (path: string) => post.mock.calls.filter(([asked]) => asked === path);

beforeEach(() => {
  mockGeneration = 1;
  server = [MASTER, VISA, AMEX];
  jest
    .mocked(apiGet)
    .mockReset()
    .mockImplementation((async () => server) as never);
  post.mockReset();
  answerPosts();
  sheet.mockReset().mockResolvedValue({ kind: "saved" });
  jest.mocked(router.push).mockClear();
  toastStore.setState({ current: null });
});

afterEach(async () => {
  await act(() => settle());
  dismissToast();
  await i18n.changeLanguage("en");
});

const open = async (client: QueryClient = newQueryClient()) => {
  const view = await renderWallet(<PaymentMethodsScreen />, client);
  return { client, view };
};
/** The cards peeking out of the pocket, front to back, as a screen reader names them. */
const strips = () =>
  screen
    .getAllByTestId(/^wallet-card-pm_[a-z]+$/)
    .map((strip) => strip.props.accessibilityLabel as string)
    .reverse();
const addButton = () => screen.getByTestId("payment-methods-add");

describe("PaymentMethodsScreen", () => {
  it("shows the wallet: the default in front and named on the pocket, each card read in full", async () => {
    await open();

    expect(screen.getByRole("header", { name: "Payment methods" })).toBeOnTheScreen();
    const face = await screen.findByTestId("wallet-pocket-default");
    expect(face).toHaveTextContent("DefaultVisa •••• 4242");
    expect(face.props.accessibilityLabel).toBe("Default card: Visa ending 4242");
    expect(strips()).toEqual([
      "Visa ending 4242, expires 12 28, default",
      "Mastercard ending 4444, expires 03 30",
      "American Express ending 0005, expires 07 27",
    ]);
    const master = screen.getByTestId("wallet-card-pm_master");
    expect(within(master).getByText("Mastercard")).toBeOnTheScreen();
    expect(within(master).getByText("•••• 4444")).toBeOnTheScreen();
    // The expiry comes out with "See all", or with the card.
    expect(screen.queryByText("Expires 03/30")).toBeNull();
    expect(screen.getByText("Tap a card to make it your default or to delete it.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add a card" })).toBeOnTheScreen();
  });

  it("keeps three cards in the pocket until See all brings every one out with its expiry", async () => {
    server = [MASTER, AMEX, VISA, DISCOVER, JCB];
    await open();

    const tab = await screen.findByRole("button", { name: "See all" });
    expect(tab).toBeCollapsed();
    expect(strips()).toHaveLength(3);
    expect(screen.queryByTestId("wallet-card-pm_jcb")).toBeNull();

    await fireEvent.press(tab);

    expect(screen.getByRole("button", { name: "Show less" })).toBeExpanded();
    expect(strips()).toEqual([
      "Visa ending 4242, expires 12 28, default",
      "Mastercard ending 4444, expires 03 30",
      "American Express ending 0005, expires 07 27",
      "Discover ending 1117, expires 12 28",
      "Card ending 0505, expires 12 28",
    ]);
    const visa = screen.getByTestId("wallet-card-pm_visa");
    expect(within(visa).getByText("Expires 12/28")).toBeOnTheScreen();
    expect(within(visa).getByTestId("wallet-card-pm_visa-default")).toHaveTextContent("Default");
    expect(screen.queryByTestId("wallet-card-pm_master-default")).toBeNull();

    await fireEvent.press(screen.getByRole("button", { name: "Show less" }));
    expect(strips()).toHaveLength(3);
  });

  it("opens a card when its strip is tapped", async () => {
    await open();

    await fireEvent.press(await screen.findByTestId("wallet-card-pm_master"));

    expect(router.push).toHaveBeenCalledWith({
      pathname: "/account/payment-methods/[id]",
      params: { id: "pm_master" },
    });
  });

  it("with cards but no default, the pocket says so and how to choose one", async () => {
    server = [MASTER, AMEX];
    await open();

    expect(await screen.findByTestId("wallet-pocket-none")).toHaveTextContent(
      "No default cardOpen a card to make it your default.",
    );
  });

  it("an empty wallet: the pocket itself is the one Add button", async () => {
    server = [];
    await open();

    const add = await screen.findByRole("button", { name: "Add a card" });
    expect(add.props.testID).toBe("wallet-pocket-add");
    expect(screen.getByText("No cards saved yet.")).toBeOnTheScreen();
    expect(screen.queryByRole("button", { name: "See all" })).toBeNull();
    expect(screen.queryByTestId("payment-methods-add")).toBeNull();
  });

  it("draws the wallet's outline while it loads", async () => {
    const list = deferred<Wallet>();
    jest.mocked(apiGet).mockReturnValue(list.promise as never);
    await open();

    expect(screen.getByTestId("payment-methods-loading")).toBeOnTheScreen();
    expect(screen.queryByTestId("wallet-pocket")).toBeNull();

    await act(async () => list.resolve([VISA]));
    expect(await screen.findByTestId("wallet-pocket-default")).toBeOnTheScreen();
    expect(screen.queryByTestId("payment-methods-loading")).toBeNull();
  });

  it.each([
    [new ApiError(503, "payments_unavailable"), "Your cards aren't available right now."],
    [new ApiError(503, "not_configured"), "Your cards aren't available right now."],
    [new NetworkError(false), "You're offline. Connect to see your cards."],
    [new ApiError(500, "internal_error"), "We couldn't load your cards."],
  ])("a wallet that cannot load (%s) says so and offers a retry", async (error, message) => {
    jest.mocked(apiGet).mockRejectedValueOnce(error);
    await open();

    const notice = await screen.findByTestId("payment-methods-failed");
    expect(within(notice).getByText(message, { exact: false })).toBeOnTheScreen();
    // No pocket, no Add: the wallet is not known.
    expect(screen.queryByTestId("wallet-pocket")).toBeNull();
    expect(screen.queryByText("Add a card")).toBeNull();
    expect(apiGet).toHaveBeenCalledTimes(1);

    await fireEvent.press(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByTestId("wallet-pocket-default")).toBeOnTheScreen();
    expect(screen.queryByTestId("payment-methods-failed")).toBeNull();
  });

  it("reads in Spanish", async () => {
    await i18n.changeLanguage("es");
    await open();

    expect(screen.getByRole("header", { name: "Métodos de pago" })).toBeOnTheScreen();
    const face = await screen.findByTestId("wallet-pocket-default");
    expect(face.props.accessibilityLabel).toBe("Tarjeta predeterminada: Visa terminada en 4242");
    expect(screen.getByRole("button", { name: "Ver todas" })).toBeOnTheScreen();
    expect(screen.getByRole("button", { name: "Agregar tarjeta" })).toBeOnTheScreen();
  });
});

describe("Add a card", () => {
  /** Stripe saves the card while its sheet is up: the server lists it from then on. */
  const sheetSaves = (saved = NEW) =>
    sheet.mockImplementation(async () => {
      server = [saved, ...server];
      return { kind: "saved" };
    });

  it("asks for a SetupIntent, opens Stripe's sheet with it, and makes the first card the default", async () => {
    server = [];
    sheetSaves();
    const { client } = await open();

    await fireEvent.press(await screen.findByRole("button", { name: "Add a card" }));
    await act(() => settle());

    expect(postsTo(SETUP_PATH)).toEqual([[SETUP_PATH, undefined, { auth: true, generation: 1 }]]);
    expect(sheet).toHaveBeenCalledTimes(1);
    expect(sheet.mock.calls[0][0]).toEqual(SETUP);
    expect(sheet.mock.calls[0][1]).toMatchObject({ merchantName: "Jack Fix It" });
    // The API never makes the first card the default by itself: the app asks for it.
    expect(postsTo(DEFAULT_PATH)).toEqual([
      [DEFAULT_PATH, undefined, { auth: true, generation: 1, params: { payment_method_id: "pm_new" } }],
    ]);
    expect(cachedWallet(client)).toEqual(["pm_new*"]);
    expect(screen.getByTestId("wallet-pocket-default")).toHaveTextContent("DefaultVisa •••• 5556");
    expect(toast()).toEqual({ message: "Card saved.", tone: "success" });
  });

  it("leaves the default alone when the wallet already has one", async () => {
    sheetSaves();
    const { client } = await open();

    await fireEvent.press(await screen.findByTestId("payment-methods-add"));
    await act(() => settle());

    expect(postsTo(DEFAULT_PATH)).toEqual([]);
    expect(cachedWallet(client)).toEqual(["pm_new", "pm_master", "pm_visa*", "pm_amex"]);
    expect(toast()).toEqual({ message: "Card saved.", tone: "success" });
  });

  it("with cards but no default, the new card becomes it, not an older one", async () => {
    server = [MASTER, AMEX];
    sheetSaves();
    const { client } = await open();

    await fireEvent.press(await screen.findByTestId("payment-methods-add"));
    await act(() => settle());

    expect(postsTo(DEFAULT_PATH).map(([, , options]) => options.params)).toEqual([
      { payment_method_id: "pm_new" },
    ]);
    expect(cachedWallet(client)).toEqual(["pm_new*", "pm_master", "pm_amex"]);
  });

  it("closing the sheet changes nothing and says nothing", async () => {
    sheet.mockResolvedValue({ kind: "canceled" });
    const { client } = await open();
    await screen.findByTestId("payment-methods-add");
    const listed = jest.mocked(apiGet).mock.calls.length;

    await fireEvent.press(addButton());
    await act(() => settle());

    expect(sheet).toHaveBeenCalledTimes(1);
    expect(jest.mocked(apiGet).mock.calls).toHaveLength(listed);
    expect(postsTo(DEFAULT_PATH)).toEqual([]);
    expect(cachedWallet(client)).toEqual(["pm_master", "pm_visa*", "pm_amex"]);
    expect(toast()).toBeNull();
    expect(screen.queryByTestId("payment-methods-add-failed")).toBeNull();
    expect(addButton()).toBeEnabled();
  });

  it.each([
    ["failed", "The card wasn't saved", "Try again, or use another card."],
    ["timeout", "Saving the card took too long", "Please try again."],
    ["unavailable", "The card form couldn't open", "Nothing was saved. Please try again."],
  ] as const)("a sheet that ends %s says so calmly", async (reason, title, body) => {
    sheet.mockResolvedValue({ kind: "failed", reason });
    await open();

    await fireEvent.press(await screen.findByTestId("payment-methods-add"));
    await act(() => settle());

    const notice = screen.getByTestId("payment-methods-add-failed");
    expect(within(notice).getByText(title)).toBeOnTheScreen();
    expect(within(notice).getByText(body)).toBeOnTheScreen();
    expect(postsTo(DEFAULT_PATH)).toEqual([]);
    expect(toast()).toBeNull();

    // The next try clears it.
    sheet.mockResolvedValue({ kind: "canceled" });
    await fireEvent.press(addButton());
    await act(() => settle());
    expect(screen.queryByTestId("payment-methods-add-failed")).toBeNull();
  });

  it.each([
    [new ApiError(503, "payments_unavailable"), "Cards can't be added right now"],
    [new ApiError(503, "not_configured"), "Cards can't be added right now"],
    [new NetworkError(false), "No connection"],
    [new ApiError(429, "rate_limited"), "That's a lot of tries at once"],
    [new ApiError(500, "internal_error"), "We couldn't start adding a card"],
  ])("when the SetupIntent is refused (%s): a calm notice and no sheet", async (error, title) => {
    post.mockRejectedValueOnce(error);
    await open();

    await fireEvent.press(await screen.findByTestId("payment-methods-add"));
    await act(() => settle());

    expect(sheet).not.toHaveBeenCalled();
    expect(
      within(screen.getByTestId("payment-methods-add-failed")).getByText(title),
    ).toBeOnTheScreen();
    expect(addButton()).toBeEnabled();
  });

  it("saved, but the default call is refused: says the card is saved and how to finish", async () => {
    server = [];
    sheetSaves();
    post.mockImplementation(async (path: string) => {
      if (path === SETUP_PATH) return { ...SETUP };
      throw new ApiError(503, "payments_unavailable");
    });
    const { client } = await open();

    await fireEvent.press(await screen.findByRole("button", { name: "Add a card" }));
    await act(() => settle());

    expect(cachedWallet(client)).toEqual(["pm_new"]);
    expect(screen.getByTestId("wallet-pocket-none")).toHaveTextContent(/No default card/);
    expect(toast()).toEqual({
      message: "Card saved. We couldn't make it your default: open the card to try again.",
      tone: "neutral",
    });
  });

  it("saved, but the wallet cannot be listed: with a default before, nothing is owed", async () => {
    sheetSaves();
    await open();
    await screen.findByTestId("payment-methods-add");
    jest.mocked(apiGet).mockRejectedValueOnce(new NetworkError(false));

    await fireEvent.press(addButton());
    await act(() => settle());

    expect(postsTo(DEFAULT_PATH)).toEqual([]);
    expect(toast()).toEqual({ message: "Card saved.", tone: "success" });
    // Listed once more afterwards: the new card shows.
    expect(await screen.findByTestId("wallet-card-pm_new")).toBeOnTheScreen();
  });

  it("is busy from the tap until it ends, and a second tap opens no second sheet", async () => {
    const setup = deferred<typeof SETUP>();
    post.mockReturnValueOnce(setup.promise);
    sheet.mockResolvedValue({ kind: "canceled" });
    await open();

    await fireEvent.press(await screen.findByTestId("payment-methods-add"));
    expect(addButton()).toBeDisabled();
    await fireEvent.press(addButton());
    await act(async () => setup.resolve(SETUP));
    await act(() => settle());

    expect(postsTo(SETUP_PATH)).toHaveLength(1);
    expect(sheet).toHaveBeenCalledTimes(1);
    expect(addButton()).toBeEnabled();
  });

  it("the screen leaving while the SetupIntent is on its way: the sheet is not wanted", async () => {
    const setup = deferred<typeof SETUP>();
    post.mockReturnValueOnce(setup.promise);
    sheet.mockImplementation(async (_setup, { stillWanted, signal }) => {
      // What the real sheet checks before it opens anything.
      expect(stillWanted()).toBe(false);
      expect(signal?.aborted).toBe(true);
      return { kind: "superseded" };
    });
    const { view } = await open();

    await fireEvent.press(await screen.findByTestId("payment-methods-add"));
    await view.unmount();
    await act(async () => setup.resolve(SETUP));
    await act(() => settle());

    expect(sheet).toHaveBeenCalledTimes(1);
    expect(toast()).toBeNull();
  });

  it("an add of a session that ended opens no sheet and touches nothing of the next one", async () => {
    const setup = deferred<typeof SETUP>();
    post.mockReturnValueOnce(setup.promise);
    const { client } = await open();

    await fireEvent.press(await screen.findByTestId("payment-methods-add"));
    // A sign-out, then another account: the cache is cleared and holds that account's wallet.
    await act(async () => {
      mockGeneration = 2;
      server = [card({ id: "pm_other", is_default: true })];
      client.clear();
      client.setQueryData(["payment-methods"], server);
    });
    await act(async () => setup.resolve(SETUP));
    await act(() => settle());

    expect(sheet).not.toHaveBeenCalled();
    expect(postsTo(DEFAULT_PATH)).toEqual([]);
    expect(cachedWallet(client)).toEqual(["pm_other*"]);
    expect(toast()).toBeNull();
  });

  it("a card saved as the session ends is not shown to the next one", async () => {
    server = [];
    const { client } = await open();
    sheet.mockImplementation(async () => {
      mockGeneration = 2;
      client.clear();
      return { kind: "saved" };
    });
    const listed = jest.mocked(apiGet).mock.calls.length;

    await fireEvent.press(await screen.findByRole("button", { name: "Add a card" }));
    await act(() => settle());

    // No list, no default call and no toast in the first session's name.
    expect(postsTo(DEFAULT_PATH)).toEqual([]);
    expect(toast()).toBeNull();
    expect(
      jest
        .mocked(apiGet)
        .mock.calls.slice(listed)
        .filter(([, options]) => (options as { generation?: number }).generation === 1),
    ).toEqual([]);
  });

  it("keeps and logs nothing of Stripe's secrets, and no card detail is in a cache key", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
      jest.spyOn(console, method).mockImplementation(),
    );
    server = [];
    sheetSaves();
    const { client } = await open();

    await fireEvent.press(await screen.findByRole("button", { name: "Add a card" }));
    await act(() => settle());
    expect(cachedWallet(client)).toEqual(["pm_new*"]);

    const logged = spies.flatMap((spy) => spy.mock.calls.map((args) => JSON.stringify(args)));
    spies.forEach((spy) => spy.mockRestore());
    const queries = client.getQueryCache().getAll();
    const mutations = client.getMutationCache().getAll();
    const kept = JSON.stringify([
      queries.map((query) => [query.queryKey, query.state.data]),
      mutations.map((mutation) => [mutation.options.mutationKey, mutation.state]),
      toastStore.getState(),
    ]);
    for (const secret of SECRETS) {
      expect(kept).not.toContain(secret);
      expect(logged.join("\n")).not.toContain(secret);
    }
    // The card's id and digits are data, never part of a key or of a log line.
    expect(queries.map((query) => query.queryHash)).toEqual(['["payment-methods"]']);
    expect(mutations.map((mutation) => mutation.options.mutationKey)).toEqual([
      ["payment-methods", "change"],
    ]);
    expect(logged.filter((line) => /pm_new|5556/.test(line))).toEqual([]);
    // Of a card the app holds exactly these fields.
    expect(Object.keys(client.getQueryData<Wallet>(["payment-methods"])![0]).sort()).toEqual([
      "brand",
      "exp_month",
      "exp_year",
      "id",
      "is_default",
      "last4",
    ]);
  });

  it("asks the wallet under its one path, with the session's sign-in", async () => {
    await open();
    await screen.findByTestId("wallet-pocket-default");

    expect(jest.mocked(apiGet).mock.calls.map(([path]) => path)).toEqual([WALLET_PATH]);
    expect(jest.mocked(apiGet).mock.calls[0][1]).toMatchObject({ auth: true });
  });
});
