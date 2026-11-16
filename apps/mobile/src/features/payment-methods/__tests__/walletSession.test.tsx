import "@/i18n";

import type { QueryClient } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import { useLocalSearchParams } from "expo-router";

import { logout } from "@/api";
import { attachQueryClient, sessionStore } from "@/api/session";
import { dismissToast, toastStore } from "@/components/ui/toast";

import {
  callPath,
  deferred,
  installFetchMock,
  jsonResponse,
  resetSecureStore,
  seedRefreshToken,
  settle,
  user,
  type FetchMock,
} from "../../../api/__tests__/helpers";
import { PaymentCardSheet } from "../PaymentCardSheet";
import { PaymentMethodsScreen } from "../PaymentMethodsScreen";
import { cachedWallet, MASTER, newQueryClient, renderWallet, toast, VISA } from "./helpers";

// The real session and API client, over a fetch the test answers: a sign-out here is the app's.
jest.mock(
  "../../../api/config",
  () => jest.requireActual("../../../api/__tests__/helpers").configMock,
);
jest.mock(
  "expo-secure-store",
  () => jest.requireActual("../../../api/__tests__/helpers").secureStoreMock,
);
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

const WALLET = "/v1/me/payment-methods";
const DEFAULT = "/v1/me/payment-methods/pm_master/default";

let fetchMock: FetchMock;
let client: QueryClient;
/** How the default call is answered: at once, unless a test holds it. */
let defaultAnswer: Promise<Response>;
/** The wallet as the server lists it; an answered default call moves its default. */
let server: (typeof VISA)[];

beforeEach(() => {
  fetchMock = installFetchMock();
  resetSecureStore();
  seedRefreshToken("refresh-1");
  client = newQueryClient();
  attachQueryClient(client);
  sessionStore.setState({
    status: "signedIn",
    user,
    accessToken: "access-1",
    accessTokenExpiresAt: Date.now() + 900_000,
    cleanupPending: false,
  });
  server = [VISA, MASTER];
  defaultAnswer = Promise.resolve(jsonResponse(200, { ...MASTER, is_default: true }));
  fetchMock.mockImplementation(async (url) => {
    const path = new URL(url).pathname;
    if (path === WALLET) return jsonResponse(200, server);
    if (path !== DEFAULT) return jsonResponse(204);
    const answer = await defaultAnswer;
    if (answer.ok)
      server = [
        { ...VISA, is_default: false },
        { ...MASTER, is_default: true },
      ];
    return answer;
  });
  toastStore.setState({ current: null });
});

afterEach(async () => {
  await act(() => settle());
  dismissToast();
});

const paths = () => fetchMock.mock.calls.map(callPath);

describe("the wallet belongs to the signed-in session", () => {
  it("a sign-out clears the wallet, and every change made to it, from the cache", async () => {
    jest.mocked(useLocalSearchParams).mockReturnValue({ id: "pm_master" });
    const view = await renderWallet(
      <>
        <PaymentMethodsScreen />
        <PaymentCardSheet />
      </>,
      client,
    );
    await screen.findByTestId("payment-card-face");
    await fireEvent.press(screen.getByRole("button", { name: "Set as default" }));
    await waitFor(() => expect(cachedWallet(client)).toEqual(["pm_visa", "pm_master*"]));
    await act(() => settle());
    expect(client.getMutationCache().getAll()).not.toHaveLength(0);

    // The signed-in screens leave with the session.
    await view.unmount();
    await act(() => logout());

    expect(paths()).toContain("/v1/auth/logout");
    expect(client.getQueryData(["payment-methods"])).toBeUndefined();
    expect(client.getQueryCache().getAll()).toEqual([]);
    expect(client.getMutationCache().getAll()).toEqual([]);
  });

  it("a change still unanswered at the sign-out draws nothing afterwards, whatever it answers", async () => {
    const held = deferred<Response>();
    defaultAnswer = held.promise;
    jest.mocked(useLocalSearchParams).mockReturnValue({ id: "pm_master" });
    const view = await renderWallet(
      <>
        <PaymentMethodsScreen />
        <PaymentCardSheet />
      </>,
      client,
    );
    await screen.findByTestId("payment-card-face");
    await fireEvent.press(screen.getByRole("button", { name: "Set as default" }));
    await waitFor(() => expect(paths()).toContain(DEFAULT));

    await view.unmount();
    await act(() => logout());
    const asked = paths().length;
    await act(async () => held.resolve(jsonResponse(500, { error: { code: "internal_error" } })));
    await act(() => settle());

    // Nothing put back into the cleared cache, nothing said, nothing asked in that session's name.
    expect(client.getQueryCache().getAll()).toEqual([]);
    expect(toast()).toBeNull();
    expect(paths()).toHaveLength(asked);
  });
});
