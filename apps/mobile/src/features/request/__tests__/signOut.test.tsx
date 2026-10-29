import "@/i18n";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack, useLocalSearchParams } from "expo-router";
import { renderRouter, screen, waitFor } from "expo-router/testing-library";
import { createElement } from "react";
import { Text } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { attachQueryClient, login, logout, type SessionUser } from "@/api";

import {
  authResponse,
  callPath,
  errorResponse,
  installFetchMock,
  jsonResponse,
  resetSecureStore,
  user,
} from "../../../api/__tests__/helpers";
import AppLayout, { unstable_settings as appSettings } from "../../../app/(app)/_layout";
import SentRoute from "../../../app/(app)/request/sent";
import { METRICS } from "../../auth/__tests__/helpers";
import { EMPTY_ADDRESS, requestDraftStore } from "../requestDraft";
import { rememberSent, sentRequest } from "../sent";
import { created, PAINTING } from "./helpers";

// The Vault's probe (#263 B1): what the flow keeps of an account outside the Query cache (the
// sent request's confirmation, the draft) goes with that account's session, through the real
// session module.
jest.mock(
  "../../../api/config",
  () => jest.requireActual("../../../api/__tests__/helpers").configMock,
);
jest.mock(
  "expo-secure-store",
  () => jest.requireActual("../../../api/__tests__/helpers").secureStoreMock,
);
jest.mock("expo-image-picker", () => ({}));
jest.mock("expo-image-manipulator", () => ({}));
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);

const ACCOUNT_A = user;
const ACCOUNT_B: SessionUser = {
  ...user,
  id: "22222222-2222-4222-8222-222222222222",
  email: "ben@example.com",
};
const SENT = created();

const EMPTY = {
  categorySlug: null,
  answers: {},
  description: "",
  address: null,
  typedAddress: EMPTY_ADDRESS,
  refusal: null,
};

let client: QueryClient;
let account: SessionUser;

async function signInAs(next: SessionUser): Promise<void> {
  account = next;
  await login({ email: next.email, password: "correct horse battery" });
}

/** A's request went through and A has started another one. */
function sendAndStartAnotherAsA(): void {
  rememberSent(SENT, ACCOUNT_A.id);
  requestDraftStore.setState({
    categorySlug: PAINTING.slug,
    answers: { surface: "ceiling" },
    description: "Water stain on the ceiling",
    address: { kind: "typed" },
    typedAddress: {
      line1: "9 Elm St",
      line2: "Apt 2",
      city: "Newark",
      state: "NJ",
      zipCode: "07102",
    },
  });
}

function HomeStub() {
  return <Text>home stub</Text>;
}

function RequestStub() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <Text>{`request ${id}`}</Text>;
}

const routes = {
  _layout: () =>
    createElement(
      SafeAreaProvider,
      { initialMetrics: METRICS },
      createElement(
        QueryClientProvider,
        { client },
        createElement(Stack, { screenOptions: { headerShown: false } }),
      ),
    ),
  "(app)/_layout": { default: AppLayout, unstable_settings: appSettings },
  "(app)/(tabs)/index": HomeStub,
  "(app)/request/sent": SentRoute,
  "(app)/requests/[id]": RequestStub,
};

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } });
  attachQueryClient(client);
  resetSecureStore();
  installFetchMock().mockImplementation(async (url) => {
    const path = callPath([url, undefined]);
    if (path === "/v1/auth/login") return jsonResponse(200, { ...authResponse(1), user: account });
    if (path === "/v1/auth/logout") return jsonResponse(204);
    if (path === "/v1/categories") return jsonResponse(200, [PAINTING]);
    return errorResponse(404, "not_found");
  });
});

afterEach(async () => {
  await logout();
});

describe("the request flow's session data", () => {
  it("sign-out clears the sent confirmation and the draft", async () => {
    await signInAs(ACCOUNT_A);
    sendAndStartAnotherAsA();
    expect(sentRequest(SENT.id, ACCOUNT_A.id)).toBe(SENT);

    await logout();

    // Gone for everyone, A included: nothing of the session outlives it.
    expect(sentRequest(SENT.id, ACCOUNT_A.id)).toBeNull();
    expect(requestDraftStore.getState()).toStrictEqual(EMPTY);

    // B signs in on the same running app and follows A's confirmation link: the app opens the
    // request through the API's owner-checked read (a 404 for B) and shows nothing of A's.
    await signInAs(ACCOUNT_B);
    const result = await renderRouter(routes, { initialUrl: `/request/sent?id=${SENT.id}` });

    await waitFor(() => expect(result.getPathname()).toBe(`/requests/${SENT.id}`));
    expect(screen.getByText(`request ${SENT.id}`)).toBeTruthy();
    expect(screen.queryByText(SENT.public_code)).toBeNull();
    expect(screen.queryByText(/12 Main St|9 Elm St/)).toBeNull();
  });

  it("a different account cannot read the in-memory confirmation", async () => {
    await signInAs(ACCOUNT_A);
    rememberSent(SENT, ACCOUNT_A.id);

    expect(sentRequest(SENT.id, ACCOUNT_B.id)).toBeNull();
    expect(sentRequest(SENT.id, undefined)).toBeNull();
    expect(sentRequest("20000000-0000-4000-8000-000000000009", ACCOUNT_A.id)).toBeNull();
    expect(sentRequest(undefined, ACCOUNT_A.id)).toBeNull();
    expect(sentRequest(SENT.id, ACCOUNT_A.id)).toBe(SENT);
  });

  it("a sign-in that brings another account forgets the first one's", async () => {
    await signInAs(ACCOUNT_A);
    sendAndStartAnotherAsA();

    await signInAs(ACCOUNT_B);

    expect(sentRequest(SENT.id, ACCOUNT_A.id)).toBeNull();
    expect(requestDraftStore.getState()).toStrictEqual(EMPTY);
  });

  it("the same account signing in again keeps them", async () => {
    await signInAs(ACCOUNT_A);
    sendAndStartAnotherAsA();

    await signInAs(ACCOUNT_A);

    expect(sentRequest(SENT.id, ACCOUNT_A.id)).toBe(SENT);
    expect(requestDraftStore.getState().description).toBe("Water stain on the ceiling");
  });
});
