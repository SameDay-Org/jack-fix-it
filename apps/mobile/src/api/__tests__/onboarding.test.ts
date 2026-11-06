import { QueryClient } from "@tanstack/react-query";

import {
  attachQueryClient,
  endOnboarding,
  login,
  logout,
  register,
  restoreSession,
  sessionStore,
} from "../session";
import {
  authResponse,
  installFetchMock,
  jsonResponse,
  resetSecureStore,
  secureStoreMock,
  seedOnboardingMarker,
  seedRefreshToken,
  settle,
  storedOnboardingMarker,
  storedRefreshToken,
  user,
  type FetchMock,
} from "./helpers";

jest.mock("../config", () => jest.requireActual("./helpers").configMock);
jest.mock("expo-secure-store", () => jest.requireActual("./helpers").secureStoreMock);

const SIGNED_OUT = {
  status: "signedOut" as const,
  user: null,
  accessToken: null,
  accessTokenExpiresAt: null,
  cleanupPending: false,
  restoreFailure: null,
  onboardingUserId: null,
};

const SIGN_UP = {
  email: user.email,
  password: "correct horse battery",
  role: "customer" as const,
  locale: "en" as const,
};

let fetchMock: FetchMock;

/** Every state the store takes from now on, to check that none shows the account off its flow. */
function recordStates() {
  const states: ReturnType<typeof sessionStore.getState>[] = [];
  const stop = sessionStore.subscribe((state) => states.push(state));
  return { states, stop };
}

beforeEach(() => {
  fetchMock = installFetchMock();
  resetSecureStore();
  attachQueryClient(new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } }));
  sessionStore.setState(SIGNED_OUT);
});

describe("the sign-up flow's marker (#292)", () => {
  it("a sign-up on the flow signs in already on it, and the device remembers it", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, authResponse(1)));
    const { states, stop } = recordStates();

    await register(SIGN_UP, { onboarding: true });
    await settle();
    stop();

    const signedIn = states.filter((state) => state.status === "signedIn");
    expect(signedIn.length).toBeGreaterThan(0);
    // The gate never renders the account signed in and off its flow, not even for one update.
    expect(signedIn.every((state) => state.onboardingUserId === user.id)).toBe(true);
    expect(storedOnboardingMarker()).toBe(user.id);
    expect(storedRefreshToken()).toBe("refresh-1");
  });

  it("a sign-up without the flow, or a login, leaves no marker", async () => {
    seedOnboardingMarker("left-behind-by-a-failed-delete");
    fetchMock.mockResolvedValue(jsonResponse(200, authResponse(1)));

    await login({ email: user.email, password: "correct horse battery" });
    await settle();

    expect(sessionStore.getState().onboardingUserId).toBeNull();
    expect(storedOnboardingMarker()).toBeNull();

    await logout();
    fetchMock.mockResolvedValue(jsonResponse(200, authResponse(2)));
    await register(SIGN_UP);
    await settle();
    expect(sessionStore.getState().onboardingUserId).toBeNull();
    expect(storedOnboardingMarker()).toBeNull();
  });

  it("a relaunch restores the account onto its flow from its first signed-in update", async () => {
    seedRefreshToken("refresh-1");
    seedOnboardingMarker(user.id);
    sessionStore.setState({ ...SIGNED_OUT, status: "restoring" });
    fetchMock.mockResolvedValue(jsonResponse(200, authResponse(2)));
    const { states, stop } = recordStates();

    await restoreSession();
    stop();

    const signedIn = states.filter((state) => state.status === "signedIn");
    expect(signedIn.length).toBeGreaterThan(0);
    expect(signedIn.every((state) => state.onboardingUserId === user.id)).toBe(true);
    expect(storedOnboardingMarker()).toBe(user.id);
  });

  it("a marker left by another account is dropped on restore", async () => {
    seedRefreshToken("refresh-1");
    seedOnboardingMarker("22222222-2222-4222-8222-222222222222");
    sessionStore.setState({ ...SIGNED_OUT, status: "restoring" });
    fetchMock.mockResolvedValue(jsonResponse(200, authResponse(2)));

    await restoreSession();
    await settle();

    expect(sessionStore.getState()).toMatchObject({ status: "signedIn", onboardingUserId: null });
    expect(storedOnboardingMarker()).toBeNull();
  });

  it("an account restored without a marker is never put on the flow", async () => {
    seedRefreshToken("refresh-1");
    sessionStore.setState({ ...SIGNED_OUT, status: "restoring" });
    fetchMock.mockResolvedValue(jsonResponse(200, authResponse(2)));

    await restoreSession();

    expect(sessionStore.getState()).toMatchObject({ status: "signedIn", onboardingUserId: null });
  });

  it("ending the flow frees the account at once and deletes the marker", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, authResponse(1)));
    await register(SIGN_UP, { onboarding: true });
    await settle();

    const ended = endOnboarding();
    expect(sessionStore.getState().onboardingUserId).toBeNull(); // before the delete lands
    await ended;

    expect(storedOnboardingMarker()).toBeNull();
    expect(sessionStore.getState().status).toBe("signedIn");
  });

  it("a sign-out ends the flow and deletes the marker with the token", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, authResponse(1)));
    await register(SIGN_UP, { onboarding: true });
    await settle();
    fetchMock.mockResolvedValue(jsonResponse(204));

    await logout();

    expect(sessionStore.getState()).toMatchObject(SIGNED_OUT);
    expect(storedOnboardingMarker()).toBeNull();
    expect(storedRefreshToken()).toBeNull();
  });

  it("an unreadable marker is no marker", async () => {
    seedRefreshToken("refresh-1");
    seedOnboardingMarker(user.id);
    const read = secureStoreMock.getItemAsync.getMockImplementation();
    secureStoreMock.getItemAsync.mockImplementation(async (key: string) => {
      if (key.endsWith("onboardingUserId")) throw new Error("keystore locked");
      return (await read?.(key)) ?? null;
    });
    sessionStore.setState({ ...SIGNED_OUT, status: "restoring" });
    fetchMock.mockResolvedValue(jsonResponse(200, authResponse(2)));

    try {
      await restoreSession();
    } finally {
      if (read) secureStoreMock.getItemAsync.mockImplementation(read);
    }

    expect(sessionStore.getState()).toMatchObject({ status: "signedIn", onboardingUserId: null });
  });
});
