import { QueryClient } from "@tanstack/react-query";

import { apiGet } from "../client";
import { ApiError, NetworkError, SessionExpiredError } from "../errors";
import {
  attachQueryClient,
  login,
  logout,
  refreshSession,
  restoreSession,
  sessionStore,
} from "../session";
import {
  authResponse,
  callBody,
  callHeader,
  callPath,
  callsTo,
  deferred,
  errorResponse,
  installFetchMock,
  jsonResponse,
  resetSecureStore,
  secureStoreMock,
  seedRefreshToken,
  settle,
  storedRefreshToken,
  user,
  watchConsole,
  type FetchMock,
} from "./helpers";

jest.mock("../config", () => jest.requireActual("./helpers").configMock);
jest.mock("expo-secure-store", () => jest.requireActual("./helpers").secureStoreMock);

const ME = "/v1/auth/me";
const REFRESH = "/v1/auth/refresh";
const LOGIN = "/v1/auth/login";
const LOGOUT = "/v1/auth/logout";

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

type Served = Response | Promise<Response>;

/**
 * The server: /me accepts the access token of pair `acceptedPair`, /refresh rotates into pair 2
 * (or whatever `refresh` returns), /login answers pair 3, /logout 204 (or whatever `logout` returns).
 */
function serve(
  options: { refresh?: () => Served; logout?: () => Served; acceptedPair?: number } = {},
) {
  const accepted = `Bearer access-${options.acceptedPair ?? 2}`;
  fetchMock.mockImplementation(async (url, init) => {
    const path = new URL(url).pathname;
    const bearer = (init?.headers as Record<string, string> | undefined)?.Authorization;
    if (path === REFRESH) return options.refresh?.() ?? jsonResponse(200, authResponse(2));
    if (path === LOGIN) return jsonResponse(200, authResponse(3));
    if (path === LOGOUT) return options.logout?.() ?? jsonResponse(204);
    if (path === ME) {
      return bearer === accepted ? jsonResponse(200, user) : errorResponse(401, "invalid_token");
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
    cleanupPending: false,
  });
}

const signIn = () => login({ email: user.email, password: "correct horse battery" });
const revokedTokens = () => callsTo(fetchMock, LOGOUT).map(callBody);

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

describe("refresh", () => {
  it("401 invalid_token triggers one refresh and one retry", async () => {
    signedInWithStaleAccessToken();
    serve();

    await expect(apiGet(ME, { auth: true })).resolves.toEqual(user);

    expect(fetchMock.mock.calls.map(callPath)).toEqual([ME, REFRESH, ME]);
    expect(callHeader(fetchMock.mock.calls[0], "Authorization")).toBe("Bearer access-1");
    expect(callHeader(fetchMock.mock.calls[2], "Authorization")).toBe("Bearer access-2");
    expect(storedRefreshToken()).toBe("refresh-2");
    expect(sessionStore.getState().accessToken).toBe("access-2");
  });

  it("concurrent 401s share a single refresh request", async () => {
    signedInWithStaleAccessToken();
    serve();

    const results = await Promise.all(Array.from({ length: 5 }, () => apiGet(ME, { auth: true })));

    expect(results).toEqual(Array(5).fill(user));
    expect(callsTo(fetchMock, REFRESH)).toHaveLength(1);
    expect(callsTo(fetchMock, ME)).toHaveLength(10);
  });

  it("restore and a concurrent request share the same refresh", async () => {
    seedRefreshToken("refresh-1");
    serve();

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
      cleanupPending: false,
    });
    serve();

    await expect(apiGet(ME, { auth: true })).resolves.toEqual(user);

    expect(fetchMock.mock.calls.map(callPath)).toEqual([REFRESH, ME]);
  });

  it("refresh 401 signs out, clears the store and the cache, and throws SessionExpiredError", async () => {
    signedInWithStaleAccessToken();
    queryClient.setQueryData(["me"], user);
    serve({ refresh: () => errorResponse(401, "invalid_refresh_token") });

    await expect(apiGet(ME, { auth: true })).rejects.toBeInstanceOf(SessionExpiredError);

    expect(storedRefreshToken()).toBeNull();
    expect(secureStoreMock.deleteItemAsync).toHaveBeenCalledTimes(1);
    expect(sessionStore.getState()).toEqual(SIGNED_OUT);
    expect(queryClient.getQueryData(["me"])).toBeUndefined();
    expect(callsTo(fetchMock, ME)).toHaveLength(1);
  });

  it("refresh network error keeps the session and the token", async () => {
    signedInWithStaleAccessToken();
    serve({ refresh: () => Promise.reject(new TypeError("Network request failed")) });

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
    serve({ refresh: () => errorResponse(503, "unavailable") });

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

  it("cancellation while awaiting the shared refresh sends nothing for the cancelled caller", async () => {
    signedInWithStaleAccessToken();
    const refresh = deferred<Response>();
    serve({ refresh: () => refresh.promise });
    const cancelled = new AbortController();

    const requestA = apiGet(ME, { auth: true, signal: cancelled.signal });
    const requestB = apiGet(ME, { auth: true });
    await settle(); // both got 401; one refresh is in flight
    cancelled.abort();
    refresh.resolve(jsonResponse(200, authResponse(2)));

    await expect(requestA).rejects.toMatchObject({ name: "AbortError" });
    await expect(requestB).resolves.toEqual(user);
    expect(callsTo(fetchMock, REFRESH)).toHaveLength(1);
    expect(callsTo(fetchMock, ME).map((call) => callHeader(call, "Authorization"))).toEqual([
      "Bearer access-1",
      "Bearer access-1",
      "Bearer access-2",
    ]);
    expect(sessionStore.getState().accessToken).toBe("access-2");
  });
});

describe("session generation", () => {
  it("a refresh released after logout is discarded", async () => {
    signedInWithStaleAccessToken();
    const refresh = deferred<Response>();
    serve({ refresh: () => refresh.promise });
    queryClient.setQueryData(["me"], user);

    const request = apiGet(ME, { auth: true });
    await settle(); // the 401 came back and the refresh is in flight
    await logout();
    expect(storedRefreshToken()).toBeNull();
    refresh.resolve(jsonResponse(200, authResponse(2)));

    await expect(request).rejects.toMatchObject({
      name: "SessionExpiredError",
      reason: "superseded",
    });
    expect(storedRefreshToken()).toBeNull();
    expect(sessionStore.getState()).toEqual(SIGNED_OUT);
    expect(queryClient.getQueryData(["me"])).toBeUndefined();
    expect(secureStoreMock.setItemAsync).not.toHaveBeenCalledWith(
      expect.any(String),
      "refresh-2",
      expect.anything(),
    );
    // The pair the stale refresh received is revoked, not kept.
    expect(revokedTokens()).toEqual([
      { refresh_token: "refresh-1" },
      { refresh_token: "refresh-2" },
    ]);
  });

  it("a newer login wins over an old refresh success", async () => {
    signedInWithStaleAccessToken();
    const refresh = deferred<Response>();
    serve({ refresh: () => refresh.promise, acceptedPair: 3 });

    const request = apiGet(ME, { auth: true });
    await settle();
    await signIn();
    expect(sessionStore.getState().accessToken).toBe("access-3");
    refresh.resolve(jsonResponse(200, authResponse(2)));

    await expect(request).rejects.toMatchObject({
      name: "SessionExpiredError",
      reason: "superseded",
    });
    expect(storedRefreshToken()).toBe("refresh-3");
    expect(sessionStore.getState()).toMatchObject({
      status: "signedIn",
      user,
      accessToken: "access-3",
    });
    expect(revokedTokens()).toEqual([{ refresh_token: "refresh-2" }]);
  });

  it("an old refresh 401 after a newer login keeps the newer session", async () => {
    signedInWithStaleAccessToken();
    const refresh = deferred<Response>();
    serve({ refresh: () => refresh.promise, acceptedPair: 3 });
    queryClient.setQueryData(["me"], user);

    const request = apiGet(ME, { auth: true });
    await settle();
    await signIn();
    refresh.resolve(errorResponse(401, "invalid_refresh_token"));

    await expect(request).rejects.toBeInstanceOf(SessionExpiredError);
    expect(storedRefreshToken()).toBe("refresh-3");
    expect(secureStoreMock.deleteItemAsync).not.toHaveBeenCalled();
    expect(sessionStore.getState()).toMatchObject({
      status: "signedIn",
      user,
      accessToken: "access-3",
    });
    expect(queryClient.getQueryData(["me"])).toEqual(user);
  });

  it("a stale restore completion is discarded", async () => {
    seedRefreshToken("refresh-1");
    const refresh = deferred<Response>();
    serve({ refresh: () => refresh.promise, acceptedPair: 3 });

    const restoring = restoreSession();
    await settle();
    await signIn();
    refresh.resolve(jsonResponse(200, authResponse(2)));
    await restoring;

    expect(storedRefreshToken()).toBe("refresh-3");
    expect(sessionStore.getState()).toMatchObject({
      status: "signedIn",
      user,
      accessToken: "access-3",
    });
  });

  it("a sign-in completed after a logout is discarded and its server session revoked", async () => {
    const loginAnswer = deferred<Response>();
    fetchMock.mockImplementation(async (url) => {
      const path = new URL(url).pathname;
      if (path === LOGIN) return loginAnswer.promise;
      if (path === LOGOUT) return jsonResponse(204);
      throw new Error(`unexpected path ${path}`);
    });

    const signingIn = signIn();
    await settle();
    await logout();
    loginAnswer.resolve(jsonResponse(200, authResponse(3)));

    await expect(signingIn).rejects.toMatchObject({
      name: "SessionExpiredError",
      reason: "superseded",
    });
    expect(storedRefreshToken()).toBeNull();
    expect(sessionStore.getState()).toEqual(SIGNED_OUT);
    expect(revokedTokens()).toEqual([{ refresh_token: "refresh-3" }]);
  });
});

describe("operation generation", () => {
  /** /me holds its first answer until the test releases it; later /me calls accept pair 3. */
  function serveWithHeldMe(held: Promise<Response>) {
    let meCalls = 0;
    fetchMock.mockImplementation(async (url, init) => {
      const path = new URL(url).pathname;
      const bearer = (init?.headers as Record<string, string> | undefined)?.Authorization;
      if (path === ME) {
        meCalls += 1;
        if (meCalls === 1) return held;
        return bearer === "Bearer access-3"
          ? jsonResponse(200, user)
          : errorResponse(401, "invalid_token");
      }
      if (path === LOGIN) return jsonResponse(200, authResponse(3));
      if (path === LOGOUT) return jsonResponse(204);
      if (path === REFRESH) return jsonResponse(200, authResponse(2));
      throw new Error(`unexpected path ${path}`);
    });
  }

  it("a held 401 released after logout and a newer login is superseded: no refresh, no retry", async () => {
    signedInWithStaleAccessToken();
    const held = deferred<Response>();
    serveWithHeldMe(held.promise);

    const request = apiGet(ME, { auth: true });
    await settle();
    await logout();
    await signIn();
    expect(sessionStore.getState().accessToken).toBe("access-3");
    held.resolve(errorResponse(401, "invalid_token"));

    await expect(request).rejects.toMatchObject({
      name: "SessionExpiredError",
      reason: "superseded",
    });
    expect(callsTo(fetchMock, REFRESH)).toHaveLength(0);
    expect(callsTo(fetchMock, ME)).toHaveLength(1);
    expect(storedRefreshToken()).toBe("refresh-3");
    expect(sessionStore.getState()).toMatchObject({
      status: "signedIn",
      user,
      accessToken: "access-3",
    });
  });

  it("a held 2xx released after a generation change is superseded too", async () => {
    signedInWithStaleAccessToken();
    const held = deferred<Response>();
    serveWithHeldMe(held.promise);

    const request = apiGet(ME, { auth: true });
    await settle();
    await logout();
    await signIn();
    held.resolve(jsonResponse(200, { ...user, email: "old-session@example.com" }));

    await expect(request).rejects.toMatchObject({
      name: "SessionExpiredError",
      reason: "superseded",
    });
    expect(callsTo(fetchMock, REFRESH)).toHaveLength(0);
    expect(callsTo(fetchMock, ME)).toHaveLength(1);
    expect(storedRefreshToken()).toBe("refresh-3");
  });

  it("a held 401 released after logout alone is superseded and nothing is re-sent", async () => {
    signedInWithStaleAccessToken();
    const held = deferred<Response>();
    serveWithHeldMe(held.promise);

    const request = apiGet(ME, { auth: true });
    await settle();
    await logout();
    held.resolve(errorResponse(401, "invalid_token"));

    await expect(request).rejects.toMatchObject({
      name: "SessionExpiredError",
      reason: "superseded",
    });
    expect(callsTo(fetchMock, REFRESH)).toHaveLength(0);
    expect(callsTo(fetchMock, ME)).toHaveLength(1);
    expect(storedRefreshToken()).toBeNull();
    expect(sessionStore.getState()).toEqual(SIGNED_OUT);
  });

  it("the normal path still does one refresh and one retry", async () => {
    signedInWithStaleAccessToken();
    serve();

    await expect(apiGet(ME, { auth: true })).resolves.toEqual(user);

    expect(fetchMock.mock.calls.map(callPath)).toEqual([ME, REFRESH, ME]);
  });
});

describe("sign-out barrier", () => {
  it("logout clears memory and the cache before the server answers", async () => {
    signedInWithStaleAccessToken();
    queryClient.setQueryData(["me"], user);
    const logoutAnswer = deferred<Response>();
    serve({ logout: () => logoutAnswer.promise });

    const signingOut = logout();
    expect(sessionStore.getState()).toEqual(SIGNED_OUT); // synchronously, before any await
    expect(queryClient.getQueryData(["me"])).toBeUndefined();
    await settle();
    expect(storedRefreshToken()).toBeNull(); // deleted before the server was told
    expect(callsTo(fetchMock, LOGOUT)).toHaveLength(1);
    logoutAnswer.resolve(jsonResponse(204));
    await signingOut;

    expect(sessionStore.getState()).toEqual(SIGNED_OUT);
    expect(revokedTokens()).toEqual([{ refresh_token: "refresh-1" }]);
  });

  it("a refresh started during a held logout is refused and cannot bring the session back", async () => {
    signedInWithStaleAccessToken();
    const logoutAnswer = deferred<Response>();
    serve({ logout: () => logoutAnswer.promise }); // a refresh would succeed, were it sent

    const signingOut = logout();
    await settle(); // /logout is in flight
    const request = apiGet(ME, { auth: true }); // would 401 and refresh under the old session
    const refreshing = refreshSession();
    await expect(request).rejects.toMatchObject({
      name: "SessionExpiredError",
      reason: "superseded",
    });
    await expect(refreshing).rejects.toMatchObject({
      name: "SessionExpiredError",
      reason: "superseded",
    });
    logoutAnswer.resolve(jsonResponse(204));
    await signingOut;

    expect(callsTo(fetchMock, REFRESH)).toHaveLength(0);
    expect(callsTo(fetchMock, ME)).toHaveLength(0);
    expect(secureStoreMock.setItemAsync).not.toHaveBeenCalled();
    expect(storedRefreshToken()).toBeNull();
    expect(sessionStore.getState()).toEqual(SIGNED_OUT);
    expect(revokedTokens()).toEqual([{ refresh_token: "refresh-1" }]);
  });

  it("a request with a fresh access token started during logout sends nothing and gets no data", async () => {
    signedInWithStaleAccessToken(); // fresh by expiry, and the server would accept access-1
    const logoutAnswer = deferred<Response>();
    serve({ logout: () => logoutAnswer.promise, acceptedPair: 1 });

    const signingOut = logout();
    await settle();
    await expect(apiGet(ME, { auth: true })).rejects.toMatchObject({
      name: "SessionExpiredError",
      reason: "superseded",
    });
    logoutAnswer.resolve(jsonResponse(204));
    await signingOut;

    expect(callsTo(fetchMock, ME)).toHaveLength(0);
    expect(callsTo(fetchMock, REFRESH)).toHaveLength(0);
    expect(sessionStore.getState()).toEqual(SIGNED_OUT);
  });

  it("a newer login started during a held logout owns the session once the old logout resolves", async () => {
    signedInWithStaleAccessToken();
    const logoutAnswer = deferred<Response>();
    serve({ logout: () => logoutAnswer.promise, acceptedPair: 3 });

    const signingOut = logout();
    await settle();
    await signIn();
    expect(sessionStore.getState()).toMatchObject({ status: "signedIn", accessToken: "access-3" });
    await expect(apiGet(ME, { auth: true })).resolves.toEqual(user); // not held by the old sign-out
    logoutAnswer.resolve(jsonResponse(204));
    await signingOut;

    expect(storedRefreshToken()).toBe("refresh-3");
    expect(sessionStore.getState()).toMatchObject({
      status: "signedIn",
      user,
      accessToken: "access-3",
      cleanupPending: false,
    });
    expect(secureStoreMock.deleteItemAsync).toHaveBeenCalledTimes(1); // the old token, before the write
    expect(callHeader(callsTo(fetchMock, ME)[0], "Authorization")).toBe("Bearer access-3");
    expect(revokedTokens()).toEqual([{ refresh_token: "refresh-1" }]);
  });

  it("a restore started during a held logout does not read or sign in from the departing token", async () => {
    signedInWithStaleAccessToken();
    const logoutAnswer = deferred<Response>();
    serve({ logout: () => logoutAnswer.promise });

    const signingOut = logout();
    const restoring = restoreSession(); // before the delete has even run
    await settle();
    await restoring;
    expect(secureStoreMock.getItemAsync).toHaveBeenCalledTimes(1); // the sign-out's own take
    expect(callsTo(fetchMock, REFRESH)).toHaveLength(0);
    logoutAnswer.resolve(jsonResponse(204));
    await signingOut;

    expect(storedRefreshToken()).toBeNull();
    expect(sessionStore.getState()).toEqual(SIGNED_OUT);
  });

  it("a sign-out forced by a refresh 401 holds the same barrier while the token is deleted", async () => {
    signedInWithStaleAccessToken();
    serve({ refresh: () => errorResponse(401, "invalid_refresh_token") });
    const deleting = deferred<void>();
    secureStoreMock.deleteItemAsync.mockReturnValueOnce(deleting.promise);

    const first = apiGet(ME, { auth: true });
    await settle(); // its refresh got 401: the sign-out began and the delete is held
    expect(sessionStore.getState().status).toBe("signedOut");
    await expect(apiGet(ME, { auth: true })).rejects.toMatchObject({
      name: "SessionExpiredError",
      reason: "superseded",
    });
    deleting.resolve();

    await expect(first).rejects.toMatchObject({ name: "SessionExpiredError", reason: "expired" });
    expect(callsTo(fetchMock, ME)).toHaveLength(1);
    expect(callsTo(fetchMock, REFRESH)).toHaveLength(1);
    expect(secureStoreMock.deleteItemAsync).toHaveBeenCalledTimes(1);
    expect(sessionStore.getState()).toEqual(SIGNED_OUT);
  });
});
