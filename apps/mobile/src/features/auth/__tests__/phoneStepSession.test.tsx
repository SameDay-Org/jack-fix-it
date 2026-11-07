import "@/i18n";

import { QueryClient } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react-native";
import { AccessibilityInfo } from "react-native";

import {
  authResponse,
  callBody,
  callHeader,
  callsTo,
  deferred,
  errorResponse,
  installFetchMock,
  jsonResponse,
  resetSecureStore,
  user,
} from "../../../api/__tests__/helpers";
import { attachQueryClient, login, register, sessionStore } from "../../../api/session";
import { onboardingMarkerStorage } from "../../../api/tokenStorage";
import { phoneFlowStore } from "../../phone/phoneFlow";
import { usePhoneStep, type PhoneStep } from "../usePhoneStep";

jest.mock(
  "../../../api/config",
  () => jest.requireActual("../../../api/__tests__/helpers").configMock,
);
jest.mock(
  "expo-secure-store",
  () => jest.requireActual("../../../api/__tests__/helpers").secureStoreMock,
);
jest.mock("../../phone/config", () => ({
  CODE_LENGTH: 6,
  phoneConfig: { countryCode: "+1", resendSeconds: 1 },
}));
jest.mock("@/components/ui", () => ({
  ...jest.requireActual("@/components/ui"),
  showToast: jest.fn(),
}));

// #295 Vault B1: the inline phone step's chain (send, resend, the check a resend runs when it
// settles, verify and the completion callback) belongs to the session the code went out in. The
// probes the Vault ran, with the real session, client and hooks; identities are synthetic. The
// client's pin already refuses the requests, so these guard the whole chain against regressions;
// the hook's own guard is proven by the code-screen case in useCodeEntry.test.tsx.
const SEND = "/v1/auth/phone/send";
const VERIFY = "/v1/auth/phone/verify";
const DIGITS = "4155550123";
const E164 = "+14155550123";
const CODE = "123456";
const second = {
  ...user,
  id: "22222222-2222-4222-8222-222222222222",
  email: "vault-b@example.invalid",
};
const signup = {
  email: user.email,
  password: "synthetic test password",
  role: "customer" as const,
  locale: "en" as const,
};
const SIGNED_OUT = {
  status: "signedOut" as const,
  user: null,
  accessToken: null,
  accessTokenExpiresAt: null,
  cleanupPending: false,
  restoreFailure: null,
  onboardingUserId: null,
};
const signInAsB = () => login({ email: second.email, password: signup.password });
/** A verify answer for whichever account the request was sent as. */
const verifiedFor = (init: RequestInit | undefined) => {
  const owner =
    (init?.headers as Record<string, string>).Authorization === "Bearer access-2" ? second : user;
  return jsonResponse(200, { ...owner, phone: E164, phone_verified: true });
};

beforeEach(() => {
  jest.useFakeTimers();
  resetSecureStore();
  sessionStore.setState(SIGNED_OUT);
  phoneFlowStore.setState({ pendingNumber: null });
  attachQueryClient(
    new QueryClient({
      defaultOptions: { queries: { gcTime: Infinity }, mutations: { gcTime: Infinity } },
    }),
  );
  jest.spyOn(AccessibilityInfo, "announceForAccessibility").mockImplementation(() => undefined);
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

/** A's account, on its sign-up flow. */
async function enter() {
  await register(signup, { onboarding: true });
  await onboardingMarkerStorage.read();
}

/** The step, with every `verifying` it rendered, so a check that only started is seen too. */
async function renderStep(onVerified: () => void) {
  const verifying: boolean[] = [];
  const hook = await renderHook(() => {
    const step = usePhoneStep(jest.fn(), onVerified);
    verifying.push(step.code.verifying);
    return step;
  });
  return { hook, verifying };
}

/** The code sent to A's number, and the resend wait over. */
async function codeSent(hook: { result: { current: PhoneStep } }) {
  await act(async () => hook.result.current.number.setText(DIGITS));
  await act(async () => hook.result.current.number.submit());
  await act(async () => jest.advanceTimersByTime(1001));
}

describe("usePhoneStep: the phone chain stays with the session it started in (#295 Vault B1)", () => {
  it("an unmounted send neither stores the number nor opens the code pane", async () => {
    const fetch = installFetchMock();
    const reply = deferred<Response>();
    let signal: AbortSignal | undefined;
    fetch.mockImplementation(async (url, init) => {
      if (url.endsWith("/register")) return jsonResponse(200, authResponse(1));
      signal = init?.signal ?? undefined;
      return reply.promise;
    });
    await enter();
    const sent = jest.fn();
    const verified = jest.fn();
    const hook = await renderHook(() => usePhoneStep(sent, verified));
    await act(async () => hook.result.current.number.setText(DIGITS));
    let sending!: Promise<void>;
    await act(async () => {
      sending = hook.result.current.number.submit();
    });

    await hook.unmount();
    expect(signal?.aborted).toBe(true);
    reply.resolve(jsonResponse(202));
    await act(async () => sending);

    expect(phoneFlowStore.getState().pendingNumber).toBeNull();
    expect(sent).not.toHaveBeenCalled();
    expect(verified).not.toHaveBeenCalled();
  });

  it("a send that settles after another sign-in opens no code pane", async () => {
    const fetch = installFetchMock();
    const reply = deferred<Response>();
    fetch.mockImplementation(async (url) => {
      if (url.endsWith("/register")) return jsonResponse(200, authResponse(1));
      if (url.endsWith("/login")) return jsonResponse(200, { ...authResponse(2), user: second });
      return reply.promise;
    });
    await enter();
    const sent = jest.fn();
    const hook = await renderHook(() => usePhoneStep(sent, jest.fn()));
    await act(async () => hook.result.current.number.setText(DIGITS));
    let sending!: Promise<void>;
    await act(async () => {
      sending = hook.result.current.number.submit();
    });

    await act(async () => signInAsB());
    await act(async () => {
      reply.resolve(jsonResponse(202));
      await sending;
    });

    expect(hook.result.current.pane).toBe("number");
    expect(hook.result.current.number.error).toBeNull();
    expect(sent).not.toHaveBeenCalled();
    await hook.unmount();
  });

  it("a verification answer for A neither updates B nor finishes the flow", async () => {
    const fetch = installFetchMock();
    const reply = deferred<Response>();
    fetch.mockImplementation(async (url) => {
      if (url.endsWith("/register")) return jsonResponse(200, authResponse(1));
      if (url.endsWith("/login")) return jsonResponse(200, { ...authResponse(2), user: second });
      if (url.endsWith(SEND)) return jsonResponse(202);
      return reply.promise;
    });
    await enter();
    const verified = jest.fn();
    const { hook } = await renderStep(verified);
    await codeSent(hook);
    await act(async () => hook.result.current.code.setCode(CODE));
    expect(callsTo(fetch, VERIFY)).toHaveLength(1);

    await act(async () => signInAsB());
    await act(async () =>
      reply.resolve(jsonResponse(200, { ...user, phone: E164, phone_verified: true })),
    );

    expect(sessionStore.getState().user).toEqual(second);
    expect(hook.result.current.code.error).toBeNull();
    expect(verified).not.toHaveBeenCalled();
    await hook.unmount();
  });

  it("a resend superseded by another sign-in never checks the digits held during it", async () => {
    const fetch = installFetchMock();
    const resent = deferred<Response>();
    let sends = 0;
    fetch.mockImplementation(async (url, init) => {
      if (url.endsWith("/register")) return jsonResponse(200, authResponse(1));
      if (url.endsWith("/login")) return jsonResponse(200, { ...authResponse(2), user: second });
      if (url.endsWith(SEND)) return ++sends === 1 ? jsonResponse(202) : resent.promise;
      return verifiedFor(init);
    });
    await enter();
    const verified = jest.fn();
    const { hook, verifying } = await renderStep(verified);
    await codeSent(hook);
    let resending!: Promise<void>;
    await act(async () => {
      resending = hook.result.current.code.resend();
    });
    await act(async () => hook.result.current.code.setCode(CODE)); // held: the resend runs
    expect(callsTo(fetch, VERIFY)).toHaveLength(0);

    await act(async () => signInAsB());
    await act(async () => {
      resent.resolve(jsonResponse(202));
      await resending;
    });

    const requests = callsTo(fetch, VERIFY).map((call) => ({
      authorization: callHeader(call, "Authorization"),
      body: callBody(call),
    }));
    expect(requests).toEqual([]);
    expect(sessionStore.getState().user).toEqual(second);
    // Nothing started: no spinner, no error, no completion.
    expect(verifying).not.toContain(true);
    expect(hook.result.current.code.error).toBeNull();
    expect(verified).not.toHaveBeenCalled();
    await hook.unmount();
  });

  it("a resend that fails because the session expired checks nothing", async () => {
    const fetch = installFetchMock();
    const resent = deferred<Response>();
    let sends = 0;
    fetch.mockImplementation(async (url, init) => {
      if (url.endsWith("/register")) return jsonResponse(200, authResponse(1));
      if (url.endsWith(SEND)) return ++sends === 1 ? jsonResponse(202) : resent.promise;
      if (url.endsWith("/refresh")) return errorResponse(401, "invalid_token");
      return verifiedFor(init);
    });
    await enter();
    const verified = jest.fn();
    const { hook, verifying } = await renderStep(verified);
    await codeSent(hook);
    let resending!: Promise<void>;
    await act(async () => {
      resending = hook.result.current.code.resend();
    });
    await act(async () => hook.result.current.code.setCode(CODE));

    // The access token is refused and the refresh too: the session ends with the resend.
    await act(async () => {
      resent.resolve(errorResponse(401, "invalid_token"));
      await resending;
    });

    expect(sessionStore.getState().status).toBe("signedOut");
    expect(callsTo(fetch, VERIFY)).toHaveLength(0);
    expect(verifying).not.toContain(true);
    expect(hook.result.current.code.error).toBeNull();
    expect(verified).not.toHaveBeenCalled();
    await hook.unmount();
  });

  it("an unmount during a resend drops the digits held during it", async () => {
    const fetch = installFetchMock();
    const resent = deferred<Response>();
    let sends = 0;
    fetch.mockImplementation(async (url, init) => {
      if (url.endsWith("/register")) return jsonResponse(200, authResponse(1));
      if (url.endsWith(SEND)) return ++sends === 1 ? jsonResponse(202) : resent.promise;
      return verifiedFor(init);
    });
    await enter();
    const verified = jest.fn();
    const { hook } = await renderStep(verified);
    await codeSent(hook);
    let resending!: Promise<void>;
    await act(async () => {
      resending = hook.result.current.code.resend();
    });
    await act(async () => hook.result.current.code.setCode(CODE));
    await hook.unmount();

    resent.resolve(jsonResponse(202));
    await act(async () => resending);

    expect(callsTo(fetch, VERIFY)).toHaveLength(0);
    expect(verified).not.toHaveBeenCalled();
    expect(phoneFlowStore.getState().pendingNumber).toBeNull();
  });

  it("in the same session, digits held during a resend are checked once it settles", async () => {
    const fetch = installFetchMock();
    const resent = deferred<Response>();
    let sends = 0;
    fetch.mockImplementation(async (url, init) => {
      if (url.endsWith("/register")) return jsonResponse(200, authResponse(1));
      if (url.endsWith(SEND)) return ++sends === 1 ? jsonResponse(202) : resent.promise;
      return verifiedFor(init);
    });
    await enter();
    const verified = jest.fn();
    const { hook } = await renderStep(verified);
    await codeSent(hook);
    let resending!: Promise<void>;
    await act(async () => {
      resending = hook.result.current.code.resend();
    });
    await act(async () => hook.result.current.code.setCode(CODE));

    await act(async () => {
      resent.resolve(jsonResponse(202));
      await resending;
    });

    expect(callsTo(fetch, VERIFY).map((call) => callHeader(call, "Authorization"))).toEqual([
      "Bearer access-1",
    ]);
    expect(sessionStore.getState().user?.phone_verified).toBe(true);
    expect(verified).toHaveBeenCalledTimes(1);
    await hook.unmount();
  });
});
