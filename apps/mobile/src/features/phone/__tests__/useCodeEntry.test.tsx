import "@/i18n";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react-native";
import type { ReactNode } from "react";

import {
  authResponse,
  callPath,
  callsTo,
  deferred,
  installFetchMock,
  jsonResponse,
  user,
  type FetchMock,
} from "../../../api/__tests__/helpers";
import { login, sessionStore } from "../../../api/session";
import { phoneConfig } from "../config";
import { useCodeEntry } from "../useCodeEntry";
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

const SEND = "/v1/auth/phone/send";
const VERIFY = "/v1/auth/phone/verify";
const VERIFIED = { ...user, phone: E164, phone_verified: true };

// The screen disables its buttons while one operation runs, but a tap and the sixth digit can land
// in the same turn, before that render. These call the hook directly, in one act, to reach the
// guards inside it.
let fetchMock: FetchMock;
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider
    // gcTime Infinity: no garbage-collection timer, so Jest exits once the tests are done.
    client={new QueryClient({ defaultOptions: { mutations: { retry: false, gcTime: Infinity } } })}
  >
    {children}
  </QueryClientProvider>
);
const renderEntry = async () => {
  const view = await renderHook(() => useCodeEntry(DIGITS, jest.fn()), { wrapper });
  await act(async () => jest.advanceTimersByTime(phoneConfig.resendSeconds * 1000));
  return view;
};
const paths = () => fetchMock.mock.calls.map(callPath);

beforeEach(() => {
  jest.useFakeTimers();
  fetchMock = installFetchMock();
  signIn();
});
afterEach(() => jest.useRealTimers());

describe("useCodeEntry: one operation at a time, within a single turn (#178 round 1)", () => {
  it("the sixth digit, then Resend in the same turn: only the verify goes out", async () => {
    const verified = deferred<Response>();
    fetchMock.mockReturnValue(verified.promise);
    const { result } = await renderEntry();

    await act(async () => {
      result.current.setCode(CODE);
      void result.current.resend();
    });

    expect(paths()).toEqual([VERIFY]);
    await act(async () => verified.resolve(jsonResponse(200, VERIFIED)));
  });

  it("Resend, then a manual verify in the same turn: only the resend goes out", async () => {
    const resent = deferred<Response>();
    fetchMock.mockImplementation((url) =>
      String(url).endsWith(SEND) ? resent.promise : Promise.resolve(jsonResponse(200, VERIFIED)),
    );
    const { result } = await renderEntry();

    await act(async () => {
      void result.current.resend();
      result.current.setCode(CODE); // held: the resend is in flight
    });
    await act(async () => {
      void result.current.submit(); // the code is complete now, but the resend still runs
    });

    expect(paths()).toEqual([SEND]);
    await act(async () => resent.resolve(jsonResponse(202)));
    expect(paths()).toEqual([SEND, VERIFY]);
  });
});

describe("useCodeEntry: a resend's held digits stay with the resend's session (#295 Vault B1)", () => {
  it("the code screen: a resend superseded by another sign-in checks nothing", async () => {
    const second = { ...user, id: "22222222-2222-4222-8222-222222222222" };
    const resent = deferred<Response>();
    fetchMock.mockImplementation((url) =>
      String(url).endsWith(SEND)
        ? resent.promise
        : String(url).endsWith("/login")
          ? Promise.resolve(jsonResponse(200, { ...authResponse(2), user: second }))
          : Promise.resolve(jsonResponse(200, { ...second, phone: E164, phone_verified: true })),
    );
    const onVerified = jest.fn();
    const verifying: boolean[] = [];
    const { result } = await renderHook(
      () => {
        const entry = useCodeEntry(DIGITS, onVerified); // no generation, as on the code screen
        verifying.push(entry.verifying);
        return entry;
      },
      { wrapper },
    );
    await act(async () => jest.advanceTimersByTime(phoneConfig.resendSeconds * 1000));
    let resending!: Promise<void>;
    await act(async () => {
      resending = result.current.resend();
    });
    await act(async () => result.current.setCode(CODE)); // held: the resend runs

    await act(async () => login({ email: second.email, password: "synthetic password" }));
    await act(async () => {
      resent.resolve(jsonResponse(202));
      await resending;
    });

    expect(callsTo(fetchMock, VERIFY)).toEqual([]);
    expect(verifying).not.toContain(true);
    expect(result.current.error).toBeNull();
    expect(onVerified).not.toHaveBeenCalled();
    expect(sessionStore.getState().user).toEqual(second);
  });
});
