import { QueryClient } from "@tanstack/react-query";

import { apiDelete } from "../client";
import {
  attachQueryClient,
  beforeSignOut,
  logout,
  sessionGeneration,
  sessionStore,
} from "../session";
import {
  callHeader,
  callPath,
  deferred,
  installFetchMock,
  jsonResponse,
  resetSecureStore,
  seedRefreshToken,
  storedRefreshToken,
  user,
  watchConsole,
  type FetchMock,
} from "./helpers";

jest.mock("../config", () => jest.requireActual("./helpers").configMock);
jest.mock("expo-secure-store", () => jest.requireActual("./helpers").secureStoreMock);

const TOKEN = "ExponentPushToken[device-1]";
const TIMEOUT_MS = 3_000;

let fetchMock: FetchMock;
let queryClient: QueryClient;
let consoleWatch: ReturnType<typeof watchConsole>;
const unregister: (() => void)[] = [];

function signIn(): void {
  seedRefreshToken("refresh-1");
  sessionStore.setState({
    status: "signedIn",
    user,
    accessToken: "access-1",
    accessTokenExpiresAt: Date.now() + 900_000,
    cleanupPending: false,
    restoreFailure: null,
    onboardingUserId: null,
  });
}

/** Registers `run` for this test only. */
function register(run: () => Promise<void>, timeoutMs = TIMEOUT_MS): void {
  unregister.push(beforeSignOut(run, { timeoutMs }));
}

/** The device-removal call a feature makes at logout, pinned to the session it starts in. */
const removeDevice = () =>
  apiDelete(
    "/v1/devices",
    { expo_push_token: TOKEN },
    { auth: true, generation: sessionGeneration() },
  ).then(() => undefined);

beforeEach(() => {
  fetchMock = installFetchMock();
  fetchMock.mockResolvedValue(jsonResponse(204));
  resetSecureStore();
  queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  attachQueryClient(queryClient);
  consoleWatch = watchConsole();
});

afterEach(() => {
  unregister.splice(0).forEach((stop) => stop());
  consoleWatch.assertNoTokenLogged();
  consoleWatch.restore();
  jest.useRealTimers();
});

describe("beforeSignOut", () => {
  it("runs while the session is still signed in, with its credentials, before the revoke", async () => {
    signIn();
    const statusDuringTask: string[] = [];
    register(async () => {
      statusDuringTask.push(sessionStore.getState().status);
      await removeDevice();
    });

    await logout();

    expect(statusDuringTask).toEqual(["signedIn"]);
    expect(fetchMock.mock.calls.map(callPath)).toEqual(["/v1/devices", "/v1/auth/logout"]);
    expect(fetchMock.mock.calls[0][1]?.method).toBe("DELETE");
    expect(callHeader(fetchMock.mock.calls[0], "Authorization")).toBe("Bearer access-1");
    expect(sessionStore.getState().status).toBe("signedOut");
    expect(storedRefreshToken()).toBeNull();
  });

  it("a failing task never stops the sign-out", async () => {
    signIn();
    register(() => Promise.reject(new Error("offline")));

    await logout();

    expect(sessionStore.getState().status).toBe("signedOut");
    expect(fetchMock.mock.calls.map(callPath)).toEqual(["/v1/auth/logout"]);
  });

  it("waits for a task at most its timeout, then signs out", async () => {
    jest.useFakeTimers();
    signIn();
    const never = deferred<void>();
    register(() => never.promise);

    const done = logout();
    await jest.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
    expect(sessionStore.getState().status).toBe("signedIn");

    await jest.advanceTimersByTimeAsync(1);
    await done;
    expect(sessionStore.getState().status).toBe("signedOut");
  });

  it("a call the task makes after its timeout is refused: the next session's token never leaves", async () => {
    jest.useFakeTimers();
    signIn();
    const late = deferred<void>();
    let lateCall: Promise<unknown> | null = null;
    register(async () => {
      const startedIn = sessionGeneration();
      await late.promise;
      lateCall = apiDelete(
        "/v1/devices",
        { expo_push_token: TOKEN },
        { auth: true, generation: startedIn },
      ).catch((error: unknown) => error);
    });

    const done = logout();
    await jest.advanceTimersByTimeAsync(TIMEOUT_MS);
    await done;
    late.resolve();
    await jest.advanceTimersByTimeAsync(0);

    expect(await lateCall).toMatchObject({ name: "SessionExpiredError" });
    expect(fetchMock.mock.calls.map(callPath)).toEqual(["/v1/auth/logout"]);
  });

  it("with no task registered, the sign-out still begins before the first await", () => {
    signIn();

    const done = logout();

    expect(sessionStore.getState().status).toBe("signedOut");
    return done;
  });

  it("is not run without a signed-in session (an offline restore's 'use another account')", async () => {
    sessionStore.setState({ status: "signedOut", user: null, accessToken: null });
    const task = jest.fn(async () => undefined);
    register(task);

    await logout();

    expect(task).not.toHaveBeenCalled();
  });

  it("a second logout while the tasks run waits for the same ones", async () => {
    signIn();
    const gate = deferred<void>();
    const task = jest.fn(() => gate.promise);
    register(task);

    const first = logout();
    const second = logout();
    gate.resolve();
    await Promise.all([first, second]);

    expect(task).toHaveBeenCalledTimes(1);
    expect(sessionStore.getState().status).toBe("signedOut");
  });

  it("an unregistered task is not run", async () => {
    signIn();
    const task = jest.fn(async () => undefined);
    beforeSignOut(task, { timeoutMs: TIMEOUT_MS })();

    await logout();

    expect(task).not.toHaveBeenCalled();
  });
});
