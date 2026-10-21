import { QueryClient } from "@tanstack/react-query";

import {
  attachQueryClient,
  login,
  logout,
  register,
  restoreSession,
  sessionStore,
} from "../session";
import {
  authResponse,
  callBody,
  callPath,
  errorResponse,
  installFetchMock,
  jsonResponse,
  resetSecureStore,
  seedRefreshToken,
  secureStoreMock,
  storedRefreshToken,
  user,
  watchConsole,
  type FetchMock,
} from "./helpers";

jest.mock("../config", () => jest.requireActual("./helpers").configMock);
jest.mock("expo-secure-store", () => jest.requireActual("./helpers").secureStoreMock);

let fetchMock: FetchMock;
let queryClient: QueryClient;
let consoleWatch: ReturnType<typeof watchConsole>;

beforeEach(() => {
  fetchMock = installFetchMock();
  resetSecureStore();
  queryClient = new QueryClient();
  attachQueryClient(queryClient);
  sessionStore.setState({
    status: "restoring",
    user: null,
    accessToken: null,
    accessTokenExpiresAt: null,
  });
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
    });
    queryClient.setQueryData(["me"], user);
    fetchMock.mockResolvedValue(errorResponse(500, "internal_error"));

    await logout();

    expect(callPath(fetchMock.mock.calls[0])).toBe("/v1/auth/logout");
    expect(callBody(fetchMock.mock.calls[0])).toEqual({ refresh_token: "refresh-1" });
    expect(storedRefreshToken()).toBeNull();
    expect(sessionStore.getState()).toEqual({
      status: "signedOut",
      user: null,
      accessToken: null,
      accessTokenExpiresAt: null,
    });
    expect(queryClient.getQueryData(["me"])).toBeUndefined();
  });
});
