import { QueryClient } from "@tanstack/react-query";

import { apiGet } from "../client";
import { ApiError, NetworkError, SessionExpiredError } from "../errors";
import { attachQueryClient, restoreSession, sessionStore } from "../session";
import {
  authResponse,
  callHeader,
  callPath,
  callsTo,
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

const ME = "/v1/auth/me";
const REFRESH = "/v1/auth/refresh";

let fetchMock: FetchMock;
let queryClient: QueryClient;
let consoleWatch: ReturnType<typeof watchConsole>;

/** The server: /me accepts only access-2, /refresh rotates refresh-1 into pair 2. */
function serveRotatingServer(options: { refresh?: () => Response | Promise<Response> } = {}) {
  fetchMock.mockImplementation(async (url, init) => {
    const path = new URL(url).pathname;
    const bearer = (init?.headers as Record<string, string> | undefined)?.Authorization;
    if (path === REFRESH)
      return options.refresh ? options.refresh() : jsonResponse(200, authResponse(2));
    if (path === ME) {
      return bearer === "Bearer access-2"
        ? jsonResponse(200, user)
        : errorResponse(401, "invalid_token");
    }
    throw new Error(`unexpected path ${path}`);
  });
}

function signedInWithStaleAccessToken(): void {
  seedRefreshToken("refresh-1");
  sessionStore.setState({
    status: "signedIn",
    user,
    accessToken: "access-1",
    accessTokenExpiresAt: Date.now() + 900_000,
  });
}

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

describe("refresh", () => {
  it("401 invalid_token triggers one refresh and one retry", async () => {
    signedInWithStaleAccessToken();
    serveRotatingServer();

    await expect(apiGet(ME, { auth: true })).resolves.toEqual(user);

    expect(fetchMock.mock.calls.map(callPath)).toEqual([ME, REFRESH, ME]);
    expect(callHeader(fetchMock.mock.calls[0], "Authorization")).toBe("Bearer access-1");
    expect(callHeader(fetchMock.mock.calls[2], "Authorization")).toBe("Bearer access-2");
    expect(storedRefreshToken()).toBe("refresh-2");
    expect(sessionStore.getState().accessToken).toBe("access-2");
  });

  it("concurrent 401s share a single refresh request", async () => {
    signedInWithStaleAccessToken();
    serveRotatingServer();

    const results = await Promise.all(Array.from({ length: 5 }, () => apiGet(ME, { auth: true })));

    expect(results).toEqual(Array(5).fill(user));
    expect(callsTo(fetchMock, REFRESH)).toHaveLength(1);
    expect(callsTo(fetchMock, ME)).toHaveLength(10);
  });

  it("restore and a concurrent request share the same refresh", async () => {
    seedRefreshToken("refresh-1");
    serveRotatingServer();

    const [, me] = await Promise.all([restoreSession(), apiGet(ME, { auth: true })]);

    expect(me).toEqual(user);
    expect(callsTo(fetchMock, REFRESH)).toHaveLength(1);
    expect(callsTo(fetchMock, ME)).toHaveLength(1);
    expect(sessionStore.getState().status).toBe("signedIn");
  });

  it("an expired access token refreshes before the request instead of waiting for a 401", async () => {
    seedRefreshToken("refresh-1");
    sessionStore.setState({
      status: "signedIn",
      user,
      accessToken: "access-1",
      accessTokenExpiresAt: Date.now() - 1,
    });
    serveRotatingServer();

    await expect(apiGet(ME, { auth: true })).resolves.toEqual(user);

    expect(fetchMock.mock.calls.map(callPath)).toEqual([REFRESH, ME]);
  });

  it("refresh 401 signs out, clears the store and the cache, and throws SessionExpiredError", async () => {
    signedInWithStaleAccessToken();
    queryClient.setQueryData(["me"], user);
    serveRotatingServer({ refresh: () => errorResponse(401, "invalid_refresh_token") });

    await expect(apiGet(ME, { auth: true })).rejects.toBeInstanceOf(SessionExpiredError);

    expect(storedRefreshToken()).toBeNull();
    expect(secureStoreMock.deleteItemAsync).toHaveBeenCalledTimes(1);
    expect(sessionStore.getState()).toEqual({
      status: "signedOut",
      user: null,
      accessToken: null,
      accessTokenExpiresAt: null,
    });
    expect(queryClient.getQueryData(["me"])).toBeUndefined();
    expect(callsTo(fetchMock, ME)).toHaveLength(1);
  });

  it("refresh network error keeps the session and the token", async () => {
    signedInWithStaleAccessToken();
    serveRotatingServer({ refresh: () => Promise.reject(new TypeError("Network request failed")) });

    await expect(apiGet(ME, { auth: true })).rejects.toBeInstanceOf(NetworkError);

    expect(storedRefreshToken()).toBe("refresh-1");
    expect(secureStoreMock.deleteItemAsync).not.toHaveBeenCalled();
    expect(sessionStore.getState()).toMatchObject({
      status: "signedIn",
      user,
      accessToken: "access-1",
    });
  });

  it("refresh 5xx keeps the session like a network error", async () => {
    signedInWithStaleAccessToken();
    serveRotatingServer({ refresh: () => errorResponse(503, "unavailable") });

    await expect(apiGet(ME, { auth: true })).rejects.toEqual(new ApiError(503, "unavailable"));

    expect(storedRefreshToken()).toBe("refresh-1");
    expect(sessionStore.getState().status).toBe("signedIn");
  });

  it("a request that still gets 401 after the retry does not loop", async () => {
    signedInWithStaleAccessToken();
    fetchMock.mockImplementation(async (url) =>
      new URL(url).pathname === REFRESH
        ? jsonResponse(200, authResponse(2))
        : errorResponse(401, "invalid_token"),
    );

    await expect(apiGet(ME, { auth: true })).rejects.toMatchObject({
      status: 401,
      code: "invalid_token",
    });

    expect(fetchMock.mock.calls.map(callPath)).toEqual([ME, REFRESH, ME]);
    expect(sessionStore.getState().status).toBe("signedIn");
  });
});
