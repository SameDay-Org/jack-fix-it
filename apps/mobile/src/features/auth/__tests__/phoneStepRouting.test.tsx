import "@/i18n";
import { act, renderRouter } from "expo-router/testing-library";
import { usePreventRemove } from "expo-router";
import { useEffect } from "react";
import { Text } from "react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { attachQueryClient, login, register, sessionStore } from "../../../api/session";
import { onboardingMarkerStorage } from "../../../api/tokenStorage";
import {
  authResponse,
  callBody,
  callHeader,
  callsTo,
  deferred,
  installFetchMock,
  jsonResponse,
  resetSecureStore,
  user,
} from "../../../api/__tests__/helpers";
import AuthLayout, { unstable_settings } from "../../../app/(auth)/_layout";
import AppLayout, { unstable_settings as appSettings } from "../../../app/(app)/_layout";
import { phoneFlowStore } from "../../phone/phoneFlow";
import { SessionGate } from "../SessionGate";
import { usePhoneStep, type PhoneStep } from "../usePhoneStep";
import { METRICS } from "./helpers";

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
  phoneConfig: { countryCode: "+1", resendSeconds: 0 },
}));
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);
const SIGNED_OUT = {
  status: "signedOut" as const,
  user: null,
  accessToken: null,
  accessTokenExpiresAt: null,
  cleanupPending: false,
  restoreFailure: null,
  onboardingUserId: null,
};
const signup = {
  email: user.email,
  password: "synthetic test password",
  role: "customer" as const,
  locale: "en" as const,
};
const second = {
  ...user,
  id: "22222222-2222-4222-8222-222222222222",
  email: "vault-b@example.invalid",
};
// The step the route host rendered last, for the test to drive.
const host: { step: PhoneStep | null } = { step: null };
const onVerified = jest.fn();
function InlinePhone() {
  const step = usePhoneStep(() => undefined, onVerified);
  // Same removal guard as SignUpScreen while a phone request is active.
  usePreventRemove(true, () => undefined);
  useEffect(() => {
    host.step = step;
  });
  return <Text>Inline phone</Text>;
}
const current = (): PhoneStep => {
  if (host.step === null) throw new Error("the phone step is not mounted");
  return host.step;
};

// #295 Vault B1, through the real SessionGate, auth/app layouts and the sign-up's removal guard: a
// login and a pending resend that settle together never send A's code with B's token.
describe("usePhoneStep under the real gate (#295 Vault B1)", () => {
  it("sends no A code as B when a login and a resend settle together", async () => {
    onVerified.mockClear();
    resetSecureStore();
    sessionStore.setState(SIGNED_OUT);
    phoneFlowStore.setState({ pendingNumber: null });
    const fetch = installFetchMock();
    const resendReply = deferred<Response>();
    const loginReply = deferred<Response>();
    let sends = 0;
    fetch.mockImplementation(async (url, init) => {
      if (url.endsWith("/register")) return jsonResponse(200, authResponse(1));
      if (url.endsWith("/login")) return loginReply.promise;
      if (url.endsWith("/send")) return ++sends === 1 ? jsonResponse(202) : resendReply.promise;
      const owner =
        (init?.headers as Record<string, string>).Authorization === "Bearer access-2"
          ? second
          : user;
      return jsonResponse(200, { ...owner, phone: "+14155550123", phone_verified: true });
    });
    const client = new QueryClient({
      defaultOptions: { queries: { gcTime: Infinity }, mutations: { gcTime: Infinity } },
    });
    attachQueryClient(client);
    await register(signup, { onboarding: true });
    await onboardingMarkerStorage.read();
    const routes = {
      _layout: () => (
        <QueryClientProvider client={client}>
          <SafeAreaProvider initialMetrics={METRICS}>
            <SessionGate />
          </SafeAreaProvider>
        </QueryClientProvider>
      ),
      "(auth)/_layout": { default: AuthLayout, unstable_settings },
      "(auth)/welcome": () => <Text>Welcome</Text>,
      "(auth)/login": () => <Text>Login</Text>,
      "(auth)/role": () => <Text>Role</Text>,
      "(auth)/sign-up": InlinePhone,
      "(app)/_layout": { default: AppLayout, unstable_settings: appSettings },
      "(app)/(tabs)/index": () => <Text>Home</Text>,
    };
    const routed = await renderRouter(routes, { initialUrl: "/sign-up" });
    await act(async () => {
      current().number.setText("4155550123");
    });
    await act(async () => {
      await current().number.submit();
    });
    let resending!: Promise<void>;
    await act(async () => {
      resending = current().code.resend();
    });
    await act(async () => {
      current().code.setCode("123456");
    });
    expect(callsTo(fetch, "/v1/auth/phone/verify")).toHaveLength(0);
    await act(async () => {
      const entering = login({ email: second.email, password: signup.password });
      loginReply.resolve(jsonResponse(200, { ...authResponse(2), user: second }));
      for (let i = 0; i < 12; i++) await Promise.resolve();
      resendReply.resolve(jsonResponse(202));
      await Promise.all([entering, resending]);
    });
    const requests = callsTo(fetch, "/v1/auth/phone/verify").map((c) => ({
      authorization: callHeader(c, "Authorization"),
      body: callBody(c),
    }));
    const verified = sessionStore.getState().user?.phone_verified;
    await routed.unmount();
    client.clear();
    expect(requests).toEqual([]);
    expect(verified).toBe(false);
    expect(onVerified).not.toHaveBeenCalled();
  });
});
