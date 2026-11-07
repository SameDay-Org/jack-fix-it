// The standalone phone steps (Account -> verify phone) keep the number a code went to, and the
// session it went in, between the phone screen and the code screen. That number belongs to the
// session: a sign-out, another account signing in (directly, or a login started during onboarding
// that lands late) and the same account signing in again all end the code step, and nothing is
// ever verified with another session's token (#295 Vault B2, #312). Real session, client, gate,
// layouts and screens; only the network and native modules are fakes.
import "@/i18n";

import { fireEvent } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { router } from "expo-router";
import { act, renderRouter } from "expo-router/testing-library";
import { Text } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import {
  authResponse,
  callHeader,
  callsTo,
  deferred,
  installFetchMock,
  jsonResponse,
  resetSecureStore,
  user,
} from "../../../api/__tests__/helpers";
import {
  attachQueryClient,
  login,
  logout,
  register,
  sessionGeneration,
  sessionStore,
} from "../../../api/session";
import AppLayout, { unstable_settings as appSettings } from "../../../app/(app)/_layout";
import AuthLayout, { unstable_settings as authSettings } from "../../../app/(auth)/_layout";
import { CodeEntryScreen } from "../../phone/CodeEntryScreen";
import { phoneFlowStore, startCodeStep } from "../../phone/phoneFlow";
import { PhoneEntryScreen } from "../../phone/PhoneEntryScreen";
import { LoginScreen } from "../LoginScreen";
import { SessionGate } from "../SessionGate";
import { SignUpScreen } from "../SignUpScreen";
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
jest.mock("expo-image-picker", () => ({ launchImageLibraryAsync: jest.fn() }));
jest.mock("expo-haptics", () => ({
  notificationAsync: jest.fn(async () => undefined),
  impactAsync: jest.fn(async () => undefined),
  NotificationFeedbackType: { Success: "success" },
  ImpactFeedbackStyle: { Light: "light" },
}));
jest.mock("../../../components/ui/IdCard", () => ({ IdCard: () => null }));

const SIGNED_OUT = {
  status: "signedOut" as const,
  user: null,
  accessToken: null,
  accessTokenExpiresAt: null,
  cleanupPending: false,
  restoreFailure: null,
  onboardingUserId: null,
};
const PASSWORD = "synthetic test password";
const signUp = {
  email: user.email,
  password: PASSWORD,
  role: "customer" as const,
  locale: "en" as const,
};
const other = { ...user, id: "22222222-2222-4222-8222-222222222222", email: "b@example.invalid" };
// A's sign-up with every card step done: only "Let's go" is left.
const finishedA = {
  ...user,
  role: "pro" as const,
  first_name: "Synthetic",
  last_name: "A",
  home_city: "Miami",
  home_state: "FL",
  photo: { url: "https://storage.example.invalid/test.jpg", expires_at: "2030-01-01T00:00:00Z" },
  phone: "+14155550999",
  phone_verified: true,
};
const NUMBER = "4155550123";
const CODE = "123456";

type Options = {
  /** Starts in A's sign-up at "Let's go", with Login's real screen and a login answer held. */
  lateLogin?: boolean;
  /** Who `/login` signs in (another account by default). */
  loginAs?: typeof user;
};

async function open({ lateLogin = false, loginAs = other }: Options = {}) {
  resetSecureStore();
  sessionStore.setState(SIGNED_OUT);
  phoneFlowStore.setState({ pendingNumber: null, pendingGeneration: null });
  const fetch = installFetchMock();
  const loginReply = deferred<Response>();
  fetch.mockImplementation(async (url: string) => {
    if (url.endsWith("/register")) {
      return jsonResponse(
        200,
        lateLogin ? { ...authResponse(1), user: finishedA } : authResponse(1),
      );
    }
    if (url.endsWith("/login")) {
      return lateLogin
        ? loginReply.promise
        : jsonResponse(200, { ...authResponse(2), user: loginAs });
    }
    if (url.endsWith("/send")) return jsonResponse(202);
    if (url.endsWith("/logout")) return jsonResponse(204);
    if (url.endsWith("/verify")) {
      return jsonResponse(200, { ...loginAs, phone: `+1${NUMBER}`, phone_verified: true });
    }
    throw new Error(`Unexpected request ${url}`);
  });
  const client = new QueryClient({
    defaultOptions: { queries: { gcTime: Infinity }, mutations: { gcTime: Infinity } },
  });
  attachQueryClient(client);
  await register(signUp, { onboarding: lateLogin });
  const routes = {
    _layout: () => (
      <QueryClientProvider client={client}>
        <SafeAreaProvider initialMetrics={METRICS}>
          <SessionGate />
        </SafeAreaProvider>
      </QueryClientProvider>
    ),
    "(auth)/_layout": { default: AuthLayout, unstable_settings: authSettings },
    "(auth)/welcome": () => <Text>Welcome</Text>,
    "(auth)/login": lateLogin ? LoginScreen : () => <Text testID="login-route">Login</Text>,
    "(auth)/role": () => <Text>Role</Text>,
    "(auth)/sign-up": SignUpScreen,
    "(app)/_layout": { default: AppLayout, unstable_settings: appSettings },
    "(app)/(tabs)/index": () => <Text>Home</Text>,
    "(app)/verify-phone/index": PhoneEntryScreen,
    "(app)/verify-phone/code": CodeEntryScreen,
    "(app)/request/(flow)/index": () => <Text>Request</Text>,
  };
  const view = await renderRouter(routes, { initialUrl: lateLogin ? "/sign-up" : "/verify-phone" });
  const sendCode = async () => {
    await fireEvent.changeText(view.getByTestId("phone-number"), NUMBER);
    await fireEvent.press(view.getByTestId("phone-send"));
    expect(view.getByTestId("code-entry-screen")).toBeTruthy();
    expect(phoneFlowStore.getState().pendingNumber).toBe(NUMBER);
  };
  if (!lateLogin) await sendCode();
  // Types the code wherever a code field is still on screen (none, once the step is gone).
  const typeCode = async () => {
    const field = view.queryByLabelText("Verification code");
    if (field) await fireEvent.changeText(field, CODE);
  };
  const close = async () => {
    await view.unmount();
    client.clear();
  };
  return { view, fetch, loginReply, sendCode, typeCode, close };
}

const NOTHING_PENDING = { pendingNumber: null, pendingGeneration: null };

describe("the standalone phone steps belong to the session the code went in (#295 Vault B2)", () => {
  it("a sign-out forgets the number before another account can open the code step", async () => {
    const { view, fetch, close } = await open();
    try {
      await act(async () => {
        await logout();
      });
      expect(phoneFlowStore.getState()).toEqual(NOTHING_PENDING);
      expect(view.queryByTestId("code-entry-screen")).toBeNull();

      await act(async () => {
        await login({ email: other.email, password: PASSWORD });
      });
      await act(async () => {
        router.push("/verify-phone/code");
      });
      expect(view.queryByTestId("code-entry-screen")).toBeNull();
      expect(view.getByTestId("phone-number").props.value).toBe("");
      expect(callsTo(fetch, "/v1/auth/phone/verify")).toEqual([]);
    } finally {
      await close();
    }
  });

  it("the signed-in phone steps cannot open Login: the auth group is protected", async () => {
    const { view, close } = await open();
    try {
      await act(async () => {
        router.push("/(auth)/login");
      });
      expect(view.queryByTestId("login-route")).toBeNull();
      expect(sessionStore.getState().user?.id).toBe(user.id);
    } finally {
      await close();
    }
  });

  it("another account signing in ends the code step and forgets the number typed for it", async () => {
    const { view, fetch, typeCode, close } = await open();
    try {
      await act(async () => {
        await login({ email: other.email, password: PASSWORD });
      });
      expect(sessionStore.getState().user?.id).toBe(other.id);
      expect(phoneFlowStore.getState()).toEqual(NOTHING_PENDING);
      expect(view.queryByTestId("code-entry-screen")).toBeNull();
      // The phone step the user lands on, and the one under it, start empty for the new account.
      const fields = view.queryAllByTestId("phone-number", { includeHiddenElements: true });
      expect(fields.map((field) => field.props.value)).toEqual(fields.map(() => ""));
      expect(fields.length).toBeGreaterThan(0);

      await typeCode();
      expect(callsTo(fetch, "/v1/auth/phone/verify")).toEqual([]);
      expect(sessionStore.getState().user?.phone_verified).toBe(false);
    } finally {
      await close();
    }
  });

  it("the same account signing in again ends the code step: its session is gone", async () => {
    const { view, fetch, typeCode, close } = await open({ loginAs: user });
    try {
      await act(async () => {
        await login({ email: user.email, password: PASSWORD });
      });
      expect(sessionStore.getState().user?.id).toBe(user.id);
      expect(view.queryByTestId("code-entry-screen")).toBeNull();
      expect(phoneFlowStore.getState()).toEqual(NOTHING_PENDING);

      await typeCode();
      expect(callsTo(fetch, "/v1/auth/phone/verify")).toEqual([]);
    } finally {
      await close();
    }
  });

  it("a login started during sign-up that lands over the code step never verifies A's number as B", async () => {
    const { view, fetch, loginReply, sendCode, typeCode, close } = await open({ lateLogin: true });
    try {
      expect(view.getByText("Let's go")).toBeTruthy();
      // From A's sign-up, Login (still reachable there) is sent for B and left before it answers.
      await act(async () => {
        router.push("/(auth)/login");
      });
      await fireEvent.changeText(view.getByTestId("login-screen-email"), other.email);
      await fireEvent.changeText(view.getByTestId("login-screen-password"), PASSWORD);
      await fireEvent.press(view.getByTestId("login-screen-submit"));
      expect(callsTo(fetch, "/v1/auth/login")).toHaveLength(1);
      await fireEvent.press(view.getByTestId("back-button"));
      expect(view.getPathname()).toBe("/sign-up");
      await fireEvent.press(view.getByTestId("sign-up-screen-submit"));
      expect(sessionStore.getState().onboardingUserId).toBeNull();
      expect(sessionStore.getState().user?.id).toBe(user.id);

      // A opens the phone steps and a code goes out with A's token.
      await act(async () => {
        router.push("/verify-phone");
      });
      await sendCode();
      expect(callHeader(callsTo(fetch, "/v1/auth/phone/send")[0], "Authorization")).toBe(
        "Bearer access-1",
      );

      // B's login lands while A's code step is open.
      await act(async () => {
        loginReply.resolve(jsonResponse(200, { ...authResponse(2), user: other }));
      });
      expect(sessionStore.getState().user?.id).toBe(other.id);
      expect(view.queryByTestId("code-entry-screen")).toBeNull();
      expect(phoneFlowStore.getState()).toEqual(NOTHING_PENDING);

      await typeCode();
      expect(callsTo(fetch, "/v1/auth/phone/verify")).toEqual([]);
      expect(sessionStore.getState().user?.phone_verified).toBe(false);
    } finally {
      await close();
    }
  });
});

describe("the number a code went to is forgotten at the session boundary itself", () => {
  // No screen mounted: the store forgets on its own, not only when the code step unmounts.
  const pendFor = async () => {
    resetSecureStore();
    sessionStore.setState(SIGNED_OUT);
    const fetch = installFetchMock();
    fetch.mockImplementation(async (url: string) => {
      if (url.endsWith("/register")) return jsonResponse(200, authResponse(1));
      if (url.endsWith("/login")) return jsonResponse(200, { ...authResponse(2), user: other });
      if (url.endsWith("/logout")) return jsonResponse(204);
      throw new Error(`Unexpected request ${url}`);
    });
    attachQueryClient(new QueryClient());
    await register(signUp);
    startCodeStep(NUMBER, sessionGeneration());
    expect(phoneFlowStore.getState().pendingNumber).toBe(NUMBER);
  };

  it("on sign-out", async () => {
    await pendFor();
    await logout();
    expect(phoneFlowStore.getState()).toEqual(NOTHING_PENDING);
  });

  it("when another account signs in", async () => {
    await pendFor();
    await login({ email: other.email, password: PASSWORD });
    expect(sessionStore.getState().user?.id).toBe(other.id);
    expect(phoneFlowStore.getState()).toEqual(NOTHING_PENDING);
  });
});
