import "@/i18n";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { AccessibilityInfo } from "react-native";

import { attachQueryClient } from "@/api";

import {
  deferred,
  errorResponse,
  installFetchMock,
  jsonResponse,
  resetSecureStore,
  secureStoreMock,
  user,
  type FetchMock,
} from "../../../api/__tests__/helpers";
import { sessionStore } from "../../../api/session";
import { useCodeEntry } from "../useCodeEntry";
import { usePhoneEntry } from "../usePhoneEntry";
import { CODE, DIGITS, E164, signIn } from "./helpers";

jest.mock(
  "../../../api/config",
  () => jest.requireActual("../../../api/__tests__/helpers").configMock,
);
jest.mock(
  "expo-secure-store",
  () => jest.requireActual("../../../api/__tests__/helpers").secureStoreMock,
);
jest.mock("@/components/ui", () => ({ showToast: jest.fn() }));

// The Vault's probe (#178): the phone number and the code live as long as the screen, not in
// any app-wide cache. The client here has the app's own defaults (not the tests' infinite gcTime).
const VERIFIED = { ...user, phone: E164, phone_verified: true };
const MINUTE_MS = 60_000;

let client: QueryClient;
let fetchMock: FetchMock;
let announce: jest.SpyInstance;
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
);

/** Everything the Query client still holds, as text: no phone, no code may be in it. */
const cached = () =>
  JSON.stringify([
    client
      .getMutationCache()
      .getAll()
      .map((mutation) => mutation.state),
    client
      .getQueryCache()
      .getAll()
      .map((query) => [query.queryKey, query.state.data]),
  ]);

beforeEach(() => {
  jest.useFakeTimers();
  client = new QueryClient();
  attachQueryClient(client);
  fetchMock = installFetchMock();
  resetSecureStore();
  signIn();
  announce = jest
    .spyOn(AccessibilityInfo, "announceForAccessibility")
    .mockImplementation(() => undefined);
});

afterEach(() => {
  client.clear();
  announce.mockRestore();
  jest.useRealTimers();
});

describe("the phone number and the code end with the screen (#178 Vault round 1)", () => {
  it.each([200, 400, 503])("after a verify answered %i, nothing is cached", async (status) => {
    fetchMock.mockResolvedValue(
      status === 200
        ? jsonResponse(200, VERIFIED)
        : errorResponse(status, status === 400 ? "invalid_code" : "verification_unavailable"),
    );
    const view = await renderHook(() => useCodeEntry(DIGITS, jest.fn()), { wrapper });
    await act(async () => view.result.current.setCode(CODE));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await view.unmount();
    await act(async () => jest.advanceTimersByTime(MINUTE_MS));

    expect(cached()).not.toContain(CODE);
    expect(cached()).not.toContain(E164);
  });

  it("a verify still pending when the screen goes leaves nothing cached", async () => {
    const answer = deferred<Response>();
    fetchMock.mockReturnValue(answer.promise);
    const view = await renderHook(() => useCodeEntry(DIGITS, jest.fn()), { wrapper });
    await act(async () => view.result.current.setCode(CODE));

    await view.unmount();

    expect(cached()).not.toContain(CODE);
    expect(cached()).not.toContain(E164);
    await act(async () => answer.resolve(jsonResponse(200, VERIFIED)));
    expect(cached()).not.toContain(CODE);
  });

  it("the phone step's send leaves no number cached", async () => {
    fetchMock.mockResolvedValue(jsonResponse(202));
    const view = await renderHook(() => usePhoneEntry(jest.fn()), { wrapper });
    await act(async () => view.result.current.setText(DIGITS));
    await act(async () => view.result.current.submit());
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await view.unmount();

    expect(cached()).not.toContain(E164);
    expect(cached()).not.toContain(DIGITS);
  });

  it("verifying writes neither the number nor the code to the secure store", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, VERIFIED));
    const view = await renderHook(() => useCodeEntry(DIGITS, jest.fn()), { wrapper });
    await act(async () => view.result.current.setCode(CODE));

    expect(sessionStore.getState().user).toEqual(VERIFIED);
    expect(secureStoreMock.setItemAsync).not.toHaveBeenCalled();
    await view.unmount();
  });
});
