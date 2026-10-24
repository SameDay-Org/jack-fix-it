import { QueryClient } from "@tanstack/react-query";

import { apiGet } from "../client";
import { LocalCleanupError, SessionExpiredError } from "../errors";
import {
  attachQueryClient,
  login,
  logout,
  register,
  restoreSession,
  sessionStore,
  setSessionUser,
} from "../session";
import {
  authResponse,
  callBody,
  callPath,
  callsTo,
  errorResponse,
  installFetchMock,
  jsonResponse,
  resetSecureStore,
  secureStoreMock,
  seedRefreshToken,
  storedRefreshToken,
  user,
  watchConsole,
  type FetchMock,
} from "./helpers";

jest.mock("../config", () => jest.requireActual("./helpers").configMock);
jest.mock("expo-secure-store", () => jest.requireActual("./helpers").secureStoreMock);

const SIGNED_OUT = {
  status: "signedOut",
  user: null,
  accessToken: null,
  accessTokenExpiresAt: null,
  cleanupPending: false,
  restoreFailure: null,
};

let fetchMock: FetchMock;
let queryClient: QueryClient;
let consoleWatch: ReturnType<typeof watchConsole>;

beforeEach(() => {
  fetchMock = installFetchMock();
  resetSecureStore();
  // gcTime Infinity: no garbage-collection timer, so Jest exits once the tests are done.
  queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  attachQueryClient(queryClient);
  sessionStore.setState({ ...SIGNED_OUT, status: "restoring" });
  consoleWatch = watchConsole();
});

afterEach(() => {
  consoleWatch.assertNoTokenLogged();
  consoleWatch.restore();
});

describe("session", () => {
  it.each([
    ["login", () => login({ email: user.email, password: "correct horse battery" })],
    [
      "register",
      () =>
        register({
          email: user.email,
          password: "correct horse battery",
          role: "customer",
          locale: "en",
        }),
    ],
  ])("%s stores refresh token in secure store and access token only in memory", async (_, act) => {
    fetchMock.mockResolvedValue(jsonResponse(200, authResponse(1)));

    await act();

    expect(storedRefreshToken()).toBe("refresh-1");
    expect(secureStoreMock.setItemAsync).toHaveBeenCalledTimes(1);
    expect(secureStoreMock.setItemAsync).toHaveBeenCalledWith(expect.any(String), "refresh-1", {
      keychainAccessible: "afterFirstUnlockThisDeviceOnly",
    });
    expect(secureStoreMock.setItemAsync).not.toHaveBeenCalledWith(
      expect.any(String),
      "access-1",
      expect.anything(),
    );
    expect(sessionStore.getState()).toMatchObject({
      status: "signedIn",
      user,
      accessToken: "access-1",
      cleanupPending: false,
    });
    expect(sessionStore.getState().accessTokenExpiresAt).toBeGreaterThan(Date.now());
  });

  it("restore with no stored token sets signedOut", async () => {
    await restoreSession();

    expect(sessionStore.getState().status).toBe("signedOut");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("restore refreshes and signs in", async () => {
    seedRefreshToken("refresh-1");
    fetchMock.mockResolvedValue(jsonResponse(200, authResponse(2)));

    await restoreSession();

    expect(callPath(fetchMock.mock.calls[0])).toBe("/v1/auth/refresh");
    expect(callBody(fetchMock.mock.calls[0])).toEqual({ refresh_token: "refresh-1" });
    expect(sessionStore.getState()).toMatchObject({
      status: "signedIn",
      user,
      accessToken: "access-2",
    });
    expect(storedRefreshToken()).toBe("refresh-2");
  });

  it("restore keeps the stored token when the server cannot be reached", async () => {
    seedRefreshToken("refresh-1");
    fetchMock.mockRejectedValue(new TypeError("Network request failed"));

    await restoreSession();

    expect(sessionStore.getState().status).toBe("signedOut");
    expect(storedRefreshToken()).toBe("refresh-1");
    expect(secureStoreMock.deleteItemAsync).not.toHaveBeenCalled();
  });

  it("logout calls the endpoint and clears everything even if the call fails", async () => {
    seedRefreshToken("refresh-1");
    sessionStore.setState({
      status: "signedIn",
      user,
      accessToken: "access-1",
      accessTokenExpiresAt: Date.now() + 900_000,
      cleanupPending: false,
    });
    queryClient.setQueryData(["me"], user);
    fetchMock.mockResolvedValue(errorResponse(500, "internal_error"));

    await logout();

    expect(callPath(fetchMock.mock.calls[0])).toBe("/v1/auth/logout");
    expect(callBody(fetchMock.mock.calls[0])).toEqual({ refresh_token: "refresh-1" });
    expect(storedRefreshToken()).toBeNull();
    expect(sessionStore.getState()).toEqual(SIGNED_OUT);
    expect(queryClient.getQueryData(["me"])).toBeUndefined();
  });

  it("a sign-out that cannot delete the stored token is observable and restore does not sign in", async () => {
    seedRefreshToken("refresh-1");
    sessionStore.setState({
      status: "signedIn",
      user,
      accessToken: "access-1",
      accessTokenExpiresAt: Date.now() + 900_000,
      cleanupPending: false,
    });
    queryClient.setQueryData(["me"], user);
    fetchMock.mockRejectedValue(new TypeError("Network request failed")); // remote logout unreachable
    secureStoreMock.deleteItemAsync.mockRejectedValueOnce(new Error("keychain busy"));

    await expect(logout()).rejects.toBeInstanceOf(LocalCleanupError);

    expect(sessionStore.getState()).toEqual({ ...SIGNED_OUT, cleanupPending: true });
    expect(queryClient.getQueryData(["me"])).toBeUndefined();
    expect(storedRefreshToken()).toBe("refresh-1"); // still on disk, and known to be

    // No request may sign back in from that entry.
    await expect(apiGet("/v1/auth/me", { auth: true })).rejects.toBeInstanceOf(SessionExpiredError);
    secureStoreMock.deleteItemAsync.mockRejectedValueOnce(new Error("keychain busy"));
    await restoreSession();
    expect(sessionStore.getState()).toEqual({ ...SIGNED_OUT, cleanupPending: true });
    expect(callsTo(fetchMock, "/v1/auth/refresh")).toHaveLength(0);

    // Once the device cooperates, restore finishes the cleanup instead of restoring.
    await restoreSession();
    expect(storedRefreshToken()).toBeNull();
    expect(sessionStore.getState()).toEqual(SIGNED_OUT);
    expect(callsTo(fetchMock, "/v1/auth/refresh")).toHaveLength(0);
  });
});

describe("setSessionUser", () => {
  const verified = { ...user, phone: "+14155550123", phone_verified: true };

  it("replaces the signed-in user with the server's fresher copy", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, authResponse(1)));
    await login({ email: user.email, password: "correct horse battery" });

    setSessionUser(verified);

    expect(sessionStore.getState().user).toEqual(verified);
    expect(sessionStore.getState().status).toBe("signedIn");
  });

  it("drops a user that arrives after a sign-out, or that is another account", async () => {
    setSessionUser(verified); // signed out
    expect(sessionStore.getState().user).toBeNull();

    fetchMock.mockResolvedValue(jsonResponse(200, authResponse(1)));
    await login({ email: user.email, password: "correct horse battery" });
    setSessionUser({ ...verified, id: "22222222-2222-4222-8222-222222222222" });
    expect(sessionStore.getState().user).toEqual(user);
  });
});

describe("restoreFailure", () => {
  const OFFLINE = { ...SIGNED_OUT, restoreFailure: "offline" };

  it("is set only when a stored token exists and the server is unreachable", async () => {
    await restoreSession(); // nothing stored: plain signed out
    expect(sessionStore.getState()).toEqual(SIGNED_OUT);

    seedRefreshToken("refresh-1");
    fetchMock.mockRejectedValue(new TypeError("Network request failed"));
    await restoreSession();
    expect(sessionStore.getState()).toEqual(OFFLINE);
    expect(storedRefreshToken()).toBe("refresh-1");

    fetchMock.mockResolvedValue(errorResponse(503, "unavailable"));
    await restoreSession();
    expect(sessionStore.getState()).toEqual(OFFLINE);
    expect(storedRefreshToken()).toBe("refresh-1");

    // The server answered and rejected the token: not an outage, and the token goes.
    fetchMock.mockResolvedValue(errorResponse(401, "invalid_refresh_token"));
    await restoreSession();
    expect(sessionStore.getState()).toEqual(SIGNED_OUT);
    expect(storedRefreshToken()).toBeNull();
  });

  it("is cleared on success", async () => {
    seedRefreshToken("refresh-1");
    fetchMock.mockRejectedValue(new TypeError("Network request failed"));
    await restoreSession();
    expect(sessionStore.getState().restoreFailure).toBe("offline");

    fetchMock.mockResolvedValue(jsonResponse(200, authResponse(2)));
    await restoreSession();
    expect(sessionStore.getState()).toMatchObject({
      status: "signedIn",
      user,
      accessToken: "access-2",
      restoreFailure: null,
    });
  });

  it("try again re-runs restore with the same stored token", async () => {
    seedRefreshToken("refresh-1");
    fetchMock.mockRejectedValue(new TypeError("Network request failed"));
    await restoreSession();
    await restoreSession();

    expect(callsTo(fetchMock, "/v1/auth/refresh").map(callBody)).toEqual([
      { refresh_token: "refresh-1" },
      { refresh_token: "refresh-1" },
    ]);
    expect(sessionStore.getState()).toEqual(OFFLINE);
  });

  it("use another account logs out locally even while the server is unreachable", async () => {
    seedRefreshToken("refresh-1");
    fetchMock.mockRejectedValue(new TypeError("Network request failed"));
    await restoreSession();
    expect(sessionStore.getState()).toEqual(OFFLINE);

    await logout();

    expect(sessionStore.getState()).toEqual(SIGNED_OUT);
    expect(storedRefreshToken()).toBeNull();
    expect(callsTo(fetchMock, "/v1/auth/logout").map(callBody)).toEqual([
      { refresh_token: "refresh-1" },
    ]);
  });
});
