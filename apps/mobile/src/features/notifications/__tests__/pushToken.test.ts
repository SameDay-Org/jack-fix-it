import type { ApiSchema } from "@jack/shared";
import { QueryClient } from "@tanstack/react-query";
import { Platform } from "react-native";

import {
  attachQueryClient,
  login,
  logout,
  refreshSession,
  sessionStore,
} from "../../../api/session";
import {
  authResponse,
  callBody,
  callHeader,
  callPath,
  deferred,
  installFetchMock,
  jsonResponse,
  resetSecureStore,
  secureStoreMock,
  user as userA,
  watchConsole,
  type FetchMock,
} from "../../../api/__tests__/helpers";
import { resetPermissionForTests } from "../permission";
import {
  armPushTokenRemoval,
  removePushToken,
  resetPushTokenForTests,
  settleOwedPushToken,
  syncPushToken,
} from "../pushToken";

jest.mock("expo-notifications");
jest.mock(
  "../../../api/config",
  () => jest.requireActual("../../../api/__tests__/helpers").configMock,
);
jest.mock(
  "expo-secure-store",
  () => jest.requireActual("../../../api/__tests__/helpers").secureStoreMock,
);
jest.mock("../config", () => ({
  notificationsConfig: { removalTimeoutMs: 3_000, projectId: "project-1" },
}));

const notifications =
  jest.requireMock<typeof import("../../../../__mocks__/expo-notifications")>("expo-notifications");
const { MOCK_PUSH_TOKEN, permission } = notifications;

const userB: ApiSchema<"UserOut"> = {
  ...userA,
  id: "22222222-2222-4222-8222-222222222222",
  email: "dan@example.com",
  role: "pro",
};

/** What the server answers each path with; `/v1/devices` answers 204 unless a test overrides it. */
type Route = (init: RequestInit | undefined) => Promise<Response>;
let routes: Record<string, Route>;
let fetchMock: FetchMock;
let queryClient: QueryClient;
let consoleWatch: ReturnType<typeof watchConsole>;
let loginAs: ApiSchema<"UserOut"> = userA;
let pair = 0;

const deviceCalls = () =>
  fetchMock.mock.calls
    .filter((call) => callPath(call) === "/v1/devices")
    .map((call) => ({
      method: call[1]?.method,
      auth: callHeader(call, "Authorization"),
      body: callBody(call),
    }));

async function signInAs(account: ApiSchema<"UserOut">): Promise<void> {
  loginAs = account;
  await login({ email: account.email, password: "a-long-password" });
}

const warnings = () =>
  (console.warn as jest.Mock).mock.calls.map((args: unknown[]) => String(args[0]));

beforeEach(() => {
  notifications.resetNotificationsMock();
  notifications.getPermissionsAsync.mockImplementation(async () => permission("granted"));
  resetPermissionForTests();
  resetPushTokenForTests();
  resetSecureStore();
  pair = 0;
  routes = {
    "/v1/auth/login": async () => {
      pair += 1;
      return jsonResponse(200, { ...authResponse(pair), user: loginAs });
    },
    "/v1/auth/logout": async () => jsonResponse(204),
    "/v1/devices": async () => jsonResponse(204),
  };
  fetchMock = installFetchMock();
  fetchMock.mockImplementation((url, init) => {
    const route = routes[new URL(url).pathname];
    if (!route) throw new Error(`unexpected ${url}`);
    return route(init);
  });
  queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  attachQueryClient(queryClient);
  sessionStore.setState({ status: "signedOut", user: null, accessToken: null });
  consoleWatch = watchConsole();
});

afterEach(() => {
  consoleWatch.assertNoTokenLogged();
  // A push token is a credential too: never in a log line.
  expect(warnings().filter((line) => /ExponentPushToken|device-token/.test(line))).toEqual([]);
  consoleWatch.restore();
  jest.useRealTimers();
});

describe("syncPushToken", () => {
  it("registers Expo's token for the signed-in account with its credentials", async () => {
    await signInAs(userA);

    await syncPushToken();

    expect(notifications.getExpoPushTokenAsync).toHaveBeenCalledWith({ projectId: "project-1" });
    expect(deviceCalls()).toEqual([
      {
        method: "PUT",
        auth: "Bearer access-1",
        body: { expo_push_token: MOCK_PUSH_TOKEN, platform: Platform.OS },
      },
    ]);
  });

  it.each([
    ["never asked", permission("undetermined")],
    ["denied", permission("denied")],
  ])("does nothing when notifications are %s, and never asks", async (_label, answer) => {
    notifications.getPermissionsAsync.mockImplementation(async () => answer);
    await signInAs(userA);

    await syncPushToken();

    expect(notifications.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(notifications.getExpoPushTokenAsync).not.toHaveBeenCalled();
    expect(deviceCalls()).toEqual([]);
  });

  it("without Firebase (no FCM in the build) logs the error class and moves on", async () => {
    notifications.getExpoPushTokenAsync.mockRejectedValue(
      Object.assign(new Error("Default FirebaseApp is not initialized ExponentPushToken[x]"), {
        code: "E_REGISTRATION_FAILED",
      }),
    );
    await signInAs(userA);

    await expect(syncPushToken()).resolves.toBe(false);

    expect(deviceCalls()).toEqual([]);
    expect(warnings()).toEqual(["Push token registration failed: Error (E_REGISTRATION_FAILED)"]);
    expect(notifications.requestPermissionsAsync).not.toHaveBeenCalled();
  });

  it("offline: the PUT fails quietly and the next trigger registers again", async () => {
    routes["/v1/devices"] = async () => {
      throw new TypeError("Network request failed");
    };
    await signInAs(userA);

    await syncPushToken();
    expect(warnings()).toEqual(["Push token registration failed: NetworkError"]);

    routes["/v1/devices"] = async () => jsonResponse(204);
    await syncPushToken();
    expect(deviceCalls().map((call) => call.method)).toEqual(["PUT", "PUT"]);
  });

  it("a changed token takes the old one off the account, then registers the new one", async () => {
    await signInAs(userA);
    await syncPushToken();
    notifications.getExpoPushTokenAsync.mockResolvedValue({
      type: "expo",
      data: "ExponentPushToken[mock-device-2]",
    });

    await syncPushToken();

    expect(deviceCalls().slice(1)).toEqual([
      {
        method: "DELETE",
        auth: "Bearer access-1",
        body: { expo_push_token: MOCK_PUSH_TOKEN },
      },
      {
        method: "PUT",
        auth: "Bearer access-1",
        body: { expo_push_token: "ExponentPushToken[mock-device-2]", platform: Platform.OS },
      },
    ]);
  });

  it("a token that arrives after the account signed out is never sent, for it or the next one", async () => {
    await signInAs(userA);
    const token = deferred<{ type: "expo"; data: string }>();
    notifications.getExpoPushTokenAsync.mockReturnValue(token.promise);

    const sync = syncPushToken();
    await logout();
    await signInAs(userB);
    token.resolve({ type: "expo", data: MOCK_PUSH_TOKEN });
    await sync;

    expect(deviceCalls()).toEqual([]);
  });
});

describe("logout", () => {
  it("removes the token with the departing session's credentials, before the session is cleared", async () => {
    await signInAs(userA);
    await syncPushToken();
    const statusAtRemoval: string[] = [];
    routes["/v1/devices"] = async (init) => {
      if (init?.method === "DELETE") statusAtRemoval.push(sessionStore.getState().status);
      return jsonResponse(204);
    };

    await logout();

    expect(statusAtRemoval).toEqual(["signedIn"]);
    expect(deviceCalls()[1]).toEqual({
      method: "DELETE",
      auth: "Bearer access-1",
      body: { expo_push_token: MOCK_PUSH_TOKEN },
    });
    const paths = fetchMock.mock.calls.map(callPath);
    expect(paths.lastIndexOf("/v1/devices")).toBeLessThan(paths.indexOf("/v1/auth/logout"));
    expect(sessionStore.getState().status).toBe("signedOut");
  });

  it("waits for a registration still in flight, so the account's PUT never lands after its DELETE", async () => {
    await signInAs(userA);
    const put = deferred<Response>();
    const order: string[] = [];
    routes["/v1/devices"] = async (init) => {
      order.push(`${init?.method} sent`);
      if (init?.method === "PUT") {
        const answer = await put.promise;
        order.push("PUT answered");
        return answer;
      }
      return jsonResponse(204);
    };

    const sync = syncPushToken();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const done = logout();
    put.resolve(jsonResponse(204));
    await Promise.all([sync, done]);

    expect(order).toEqual(["PUT sent", "PUT answered", "DELETE sent"]);
  });

  it("offline: the sign-out completes, and the next account's sign-in moves the token to it", async () => {
    await signInAs(userA);
    await syncPushToken();
    routes["/v1/devices"] = async () => {
      throw new TypeError("Network request failed");
    };

    await logout();
    expect(sessionStore.getState().status).toBe("signedOut");
    expect(warnings()).toContain("Push token removal failed: NetworkError");

    routes["/v1/devices"] = async () => jsonResponse(204);
    await signInAs(userB);
    await syncPushToken();

    // The API's upsert moves a token to whoever registers it: A stops receiving this device's pushes.
    expect(deviceCalls().at(-1)).toEqual({
      method: "PUT",
      auth: "Bearer access-2",
      body: { expo_push_token: MOCK_PUSH_TOKEN, platform: Platform.OS },
    });
  });

  it("a server that never answers holds the sign-out at most the removal timeout", async () => {
    await signInAs(userA);
    await syncPushToken();
    jest.useFakeTimers();
    routes["/v1/devices"] = () => new Promise<Response>(() => undefined);

    const done = logout();
    await jest.advanceTimersByTimeAsync(2_999);
    expect(sessionStore.getState().status).toBe("signedIn");
    await jest.advanceTimersByTimeAsync(1);
    await done;

    expect(sessionStore.getState().status).toBe("signedOut");
  });

  it("with no token to be had (no FCM in the build) nothing is sent, quietly", async () => {
    notifications.getExpoPushTokenAsync.mockRejectedValue(new Error("no FCM"));
    await signInAs(userA);
    await syncPushToken();

    await logout();

    expect(deviceCalls()).toEqual([]);
    expect(fetchMock.mock.calls.map(callPath)).toEqual(["/v1/auth/login", "/v1/auth/logout"]);
  });

  it("a logout right after start, before this launch fetched the token, still removes it", async () => {
    // Notifications turned off in the phone's settings meanwhile: no registration this launch.
    notifications.getPermissionsAsync.mockImplementation(async () => permission("denied", false));
    await signInAs(userA);
    armPushTokenRemoval();

    await logout();

    // No record on the device, so any account may hold it: it moves here, then comes off.
    expect(deviceCalls()).toEqual([
      {
        method: "PUT",
        auth: "Bearer access-1",
        body: { expo_push_token: MOCK_PUSH_TOKEN, platform: Platform.OS },
      },
      { method: "DELETE", auth: "Bearer access-1", body: { expo_push_token: MOCK_PUSH_TOKEN } },
    ]);
  });

  it("the next account registers the known token even when Expo's service fails then", async () => {
    await signInAs(userA);
    await syncPushToken();
    routes["/v1/devices"] = async () => {
      throw new TypeError("Network request failed");
    };
    await logout(); // A's removal fails
    routes["/v1/devices"] = async () => jsonResponse(204);
    notifications.getExpoPushTokenAsync.mockRejectedValue(new Error("SERVICE_UNAVAILABLE"));
    await signInAs(userB);

    await expect(syncPushToken()).resolves.toBe(true);

    expect(deviceCalls().at(-1)).toEqual({
      method: "PUT",
      auth: "Bearer access-2",
      body: { expo_push_token: MOCK_PUSH_TOKEN, platform: Platform.OS },
    });
    expect(warnings()).toContain("Push token refresh failed: Error");
  });

  it("a session the server ended during the removal, then another sign-in: the new one stays", async () => {
    await signInAs(userA);
    await syncPushToken();
    const removal = deferred<Response>();
    routes["/v1/devices"] = () => removal.promise;

    const done = logout();
    await new Promise((resolve) => setTimeout(resolve, 0));
    routes["/v1/devices"] = async () => jsonResponse(204);
    await signInAs(userB); // as after A's session ended
    removal.resolve(jsonResponse(204));
    await done;

    expect(sessionStore.getState()).toMatchObject({ status: "signedIn", user: { id: userB.id } });
  });

  it("a removal asked outside a session sends nothing", async () => {
    await expect(removePushToken()).resolves.toBeUndefined();
    expect(deviceCalls()).toEqual([]);
  });
});

describe("a removal that never reached the server, across a restart (#334 B1)", () => {
  const PUSH_TOKEN_KEY = "jackfixit.notifications.pushToken";
  const ROTATED = "ExponentPushToken[mock-device-2]";

  /**
   * The API's devices for this phone's tokens, by holder (the bearer that registered it): a PUT
   * moves a token to its caller (the upsert), a DELETE takes it off its caller only.
   */
  function deviceServer() {
    const holders = new Map<string, string>();
    let offline = false;
    routes["/v1/devices"] = async (init) => {
      if (offline) throw new TypeError("Network request failed");
      const auth = new Headers(init?.headers).get("Authorization") ?? "";
      const { expo_push_token: token } = JSON.parse(String(init?.body)) as {
        expo_push_token: string;
      };
      if (init?.method === "PUT") holders.set(token, auth);
      if (init?.method === "DELETE" && holders.get(token) === auth) holders.delete(token);
      return jsonResponse(204);
    };
    return {
      holders,
      setOffline: (value: boolean) => {
        offline = value;
      },
    };
  }

  /** The app is killed and launched again: this process's state goes, the device's store stays. */
  const restart = () => resetPushTokenForTests();

  const stored = async () => {
    const value = await secureStoreMock.getItemAsync(PUSH_TOKEN_KEY);
    return value === null ? null : (JSON.parse(value) as unknown);
  };

  /** A registers the token, then logs out offline: the removal never reaches the server. */
  async function offlineLogoutOfA(server: ReturnType<typeof deviceServer>) {
    await signInAs(userA);
    await syncPushToken();
    expect(server.holders.get(MOCK_PUSH_TOKEN)).toBe("Bearer access-1");
    server.setOffline(true);
    await logout();
    expect(sessionStore.getState().status).toBe("signedOut");
    expect(server.holders.get(MOCK_PUSH_TOKEN)).toBe("Bearer access-1");
    server.setOffline(false);
  }

  it.each([
    ["without", false],
    ["with", true],
  ])(
    "B signs in %s a restart while Expo's service fails: the token moves off A to B",
    async (_label, relaunched) => {
      const server = deviceServer();
      await offlineLogoutOfA(server);
      if (relaunched) restart();
      notifications.getExpoPushTokenAsync.mockRejectedValue(new Error("SERVICE_UNAVAILABLE"));
      await signInAs(userB);

      await expect(syncPushToken()).resolves.toBe(true);

      expect(server.holders.get(MOCK_PUSH_TOKEN)).toBe("Bearer access-2");
      // Still owed, by B now: whatever ends B's session, the next sign-in moves it off B.
      expect(await stored()).toEqual({ token: MOCK_PUSH_TOKEN, owed: true });
    },
  );

  /** A registers the token, then the server refuses A's refresh token: no removal runs. */
  async function expiredSessionOfA(server: ReturnType<typeof deviceServer>) {
    await signInAs(userA);
    await syncPushToken();
    routes["/v1/auth/refresh"] = async () =>
      jsonResponse(401, { error: { code: "invalid_refresh_token" } });
    await expect(refreshSession()).rejects.toMatchObject({ name: "SessionExpiredError" });
    expect(server.holders.get(MOCK_PUSH_TOKEN)).toBe("Bearer access-1");
  }

  it("A's refresh token refused, then B signs in without a restart, notifications off: the token moves to B and comes off", async () => {
    const server = deviceServer();
    await expiredSessionOfA(server);
    notifications.getPermissionsAsync.mockImplementation(async () => permission("denied", false));
    await signInAs(userB);

    // A's own registration in this process is no reason to skip the move: B is another session.
    await expect(settleOwedPushToken()).resolves.toBe(true);

    expect(server.holders.size).toBe(0);
    expect(await stored()).toEqual({ token: MOCK_PUSH_TOKEN, owed: false });
  });

  /** The store fails the next `times` reads of the token's record, then answers again. */
  function failReads(times: number): () => void {
    const read = secureStoreMock.getItemAsync.getMockImplementation();
    let left = times;
    secureStoreMock.getItemAsync.mockImplementation(async (key: string) => {
      if (key === PUSH_TOKEN_KEY && left-- > 0) {
        throw Object.assign(new Error(`keystore ${MOCK_PUSH_TOKEN}`), { code: "E_STORE_READ" });
      }
      return read ? read(key) : null;
    });
    return () => {
      if (read) secureStoreMock.getItemAsync.mockImplementation(read);
    };
  }

  /**
   * The store records the next `after` writes of the token's record, fails the `times` that
   * follow, then records again.
   */
  function failWrites(times: number, after = 0): () => void {
    const write = secureStoreMock.setItemAsync.getMockImplementation();
    let passed = 0;
    let left = times;
    secureStoreMock.setItemAsync.mockImplementation(async (key: string, value: string) => {
      if (key === PUSH_TOKEN_KEY && passed++ >= after && left-- > 0) {
        throw Object.assign(new Error(`keystore ${value}`), { code: "E_STORE_WRITE" });
      }
      await write?.(key, value);
    });
    return () => {
      if (write) secureStoreMock.setItemAsync.mockImplementation(write);
    };
  }

  it.each([
    ["off", false, "Owed push token removal failed"],
    ["on", true, "Push token registration failed"],
  ])(
    "the device's record unreadable at B's sign-in (notifications %s), readable on the next try: nothing is sent, then the token moves off A",
    async (_label, on, what) => {
      const server = deviceServer();
      await expiredSessionOfA(server);
      restart();
      if (!on) {
        notifications.getPermissionsAsync.mockImplementation(async () =>
          permission("denied", false),
        );
      }
      await signInAs(userB);
      const before = deviceCalls().length;
      const restore = failReads(1);
      try {
        // A read that failed is not "nothing owed": the caller is told, and tries again.
        await expect(on ? syncPushToken() : settleOwedPushToken()).resolves.toBe(false);
        expect(deviceCalls()).toHaveLength(before);
        expect(server.holders.get(MOCK_PUSH_TOKEN)).toBe("Bearer access-1");

        // The next return to the app: the failure was not kept, the record is read again.
        await expect(on ? syncPushToken() : settleOwedPushToken()).resolves.toBe(true);
      } finally {
        restore();
      }

      expect([...server.holders]).toEqual(on ? [[MOCK_PUSH_TOKEN, "Bearer access-2"]] : []);
      expect(await stored()).toEqual({ token: MOCK_PUSH_TOKEN, owed: on });
      expect(warnings()).toEqual([`${what}: PushTokenStateError (E_STORE_READ)`]);
    },
  );

  it("the device's record unreadable for B's whole session: B's logout writes nothing over it, and the next sign-in moves the token off A", async () => {
    const server = deviceServer();
    await expiredSessionOfA(server);
    restart();
    notifications.getPermissionsAsync.mockImplementation(async () => permission("denied", false));
    await signInAs(userB);
    const before = deviceCalls().length;
    const kept = await stored();
    const restore = failReads(Infinity);
    try {
      await expect(settleOwedPushToken()).resolves.toBe(false);
      expect(deviceCalls()).toHaveLength(before);

      await logout();
    } finally {
      restore();
    }

    // What the record marks cannot be read, so nothing is written over it and no PUT goes out
    // under it: only the DELETE, which takes nothing off B here.
    expect(deviceCalls().slice(before)).toEqual([
      { method: "DELETE", auth: "Bearer access-2", body: { expo_push_token: MOCK_PUSH_TOKEN } },
    ]);
    expect(server.holders.get(MOCK_PUSH_TOKEN)).toBe("Bearer access-1");
    expect(await stored()).toEqual(kept);
    expect(kept).toMatchObject({ token: MOCK_PUSH_TOKEN, owed: true });

    // Readable again at the next sign-in, and still saying A may hold the token.
    restart();
    await signInAs(userB);
    await expect(settleOwedPushToken()).resolves.toBe(true);
    expect(server.holders.size).toBe(0);
    expect(await stored()).toEqual({ token: MOCK_PUSH_TOKEN, owed: false });
  });

  it("the owed mark cannot be written: no PUT goes out under a record that says nobody holds the token, and the next try registers", async () => {
    const server = deviceServer();
    await signInAs(userA);
    await syncPushToken();
    await logout(); // confirmed by the server: the record says nobody holds the token
    expect(await stored()).toEqual({ token: MOCK_PUSH_TOKEN, owed: false });
    await signInAs(userA);
    const before = deviceCalls().length;
    const restore = failWrites(2);
    try {
      // Twice: the mark that was not written is not remembered as written either, so the second
      // try sends nothing on the strength of the first.
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        await expect(syncPushToken()).resolves.toBe(false);
        expect(deviceCalls()).toHaveLength(before);
        expect(server.holders.size).toBe(0);
        expect(await stored()).toEqual({ token: MOCK_PUSH_TOKEN, owed: false });
      }

      // The next return to the app: the store records again.
      await expect(syncPushToken()).resolves.toBe(true);
    } finally {
      restore();
    }

    expect(server.holders.get(MOCK_PUSH_TOKEN)).toBe("Bearer access-2");
    expect(await stored()).toEqual({ token: MOCK_PUSH_TOKEN, owed: true });
    expect(warnings()).toEqual([
      "Push token registration failed: PushTokenStateError (E_STORE_WRITE)",
      "Push token registration failed: PushTokenStateError (E_STORE_WRITE)",
    ]);
  });

  it("a repeated registration records its PUT as unanswered first: a store failing then stops it, and the next try registers", async () => {
    const server = deviceServer();
    await signInAs(userA);
    await syncPushToken();
    const sent = deviceCalls().length;
    const restore = failWrites(1);
    try {
      await expect(syncPushToken()).resolves.toBe(false);
    } finally {
      restore();
    }
    // No PUT without its mark: one whose answer is lost would leave no trace that it may land late.
    expect(deviceCalls()).toHaveLength(sent);
    expect(warnings()).toEqual([
      "Push token registration failed: PushTokenStateError (E_STORE_WRITE)",
    ]);

    await expect(syncPushToken()).resolves.toBe(true);

    expect(server.holders.get(MOCK_PUSH_TOKEN)).toBe("Bearer access-1");
    expect(await stored()).toEqual({ token: MOCK_PUSH_TOKEN, owed: true });
  });

  it("a logout with nothing recorded and a mark that cannot be written sends nothing", async () => {
    const server = deviceServer();
    notifications.getPermissionsAsync.mockImplementation(async () => permission("denied", false));
    await signInAs(userA);
    armPushTokenRemoval();
    const restore = failWrites(Infinity);
    try {
      await logout();
    } finally {
      restore();
    }

    expect(sessionStore.getState().status).toBe("signedOut");
    expect(deviceCalls()).toEqual([]);
    expect(server.holders.size).toBe(0);
    expect(warnings()).toEqual(["Push token removal failed: PushTokenStateError (E_STORE_WRITE)"]);
  });

  it("settle: the DELETE lands but the cleared mark cannot be written: reported, and the next try settles again", async () => {
    const server = deviceServer();
    await offlineLogoutOfA(server);
    restart();
    notifications.getPermissionsAsync.mockImplementation(async () => permission("denied", false));
    await signInAs(userB);
    // The move's two writes go through (unanswered, then answered); the cleared mark does not.
    const restore = failWrites(1, 2);
    try {
      await expect(settleOwedPushToken()).resolves.toBe(false);
    } finally {
      restore();
    }
    // Off A already. The device still says owed, which costs one more move and removal.
    expect(server.holders.size).toBe(0);
    expect(await stored()).toEqual({ token: MOCK_PUSH_TOKEN, owed: true });

    await expect(settleOwedPushToken()).resolves.toBe(true);

    expect(server.holders.size).toBe(0);
    expect(await stored()).toEqual({ token: MOCK_PUSH_TOKEN, owed: false });
  });

  it("notifications turned off while signed in: the token comes off this account, no move first", async () => {
    const server = deviceServer();
    await signInAs(userA);
    await syncPushToken();
    notifications.getPermissionsAsync.mockImplementation(async () => permission("denied", false));
    const before = deviceCalls().length;

    await expect(settleOwedPushToken()).resolves.toBe(true);

    expect(deviceCalls().slice(before)).toEqual([
      { method: "DELETE", auth: "Bearer access-1", body: { expo_push_token: MOCK_PUSH_TOKEN } },
    ]);
    expect(server.holders.size).toBe(0);
    expect(await stored()).toEqual({ token: MOCK_PUSH_TOKEN, owed: false });
  });

  describe.each([
    ["off", false],
    ["on", true],
  ])("the app dies during A's logout, then B signs in with notifications %s", (_label, on) => {
    it.each([
      ["before the DELETE reaches the server", "before"],
      ["mid-request: the server applied the DELETE, its answer never came", "mid"],
      ["after the DELETE's 204, before the cleared mark is written", "after"],
    ] as const)("%s: B's sign-in settles the token, idempotently", async (_step, cut) => {
      const server = deviceServer();
      await signInAs(userA);
      await syncPushToken();
      const reachable = routes["/v1/devices"];
      routes["/v1/devices"] = async (init) => {
        if (init?.method !== "DELETE") return reachable(init);
        if (cut === "before") return new Promise<Response>(() => undefined);
        const answer = await reachable(init);
        return cut === "mid" ? new Promise<Response>(() => undefined) : answer;
      };
      // The kill lands before the cleared mark reaches the store.
      const write = secureStoreMock.setItemAsync.getMockImplementation();
      secureStoreMock.setItemAsync.mockImplementation(async (key: string, value: string) => {
        if (cut === "after" && key === PUSH_TOKEN_KEY && value.includes('"owed":false')) return;
        await write?.(key, value);
      });
      try {
        jest.useFakeTimers();
        const done = logout();
        await jest.advanceTimersByTimeAsync(3_000);
        await done;
        jest.useRealTimers();
      } finally {
        if (write) secureStoreMock.setItemAsync.mockImplementation(write);
      }
      expect(await stored()).toEqual({ token: MOCK_PUSH_TOKEN, owed: true });
      expect(server.holders.has(MOCK_PUSH_TOKEN)).toBe(cut === "before");

      restart();
      routes["/v1/devices"] = reachable;
      if (!on) {
        notifications.getPermissionsAsync.mockImplementation(async () =>
          permission("denied", false),
        );
      }
      await signInAs(userB);

      await expect(on ? syncPushToken() : settleOwedPushToken()).resolves.toBe(true);

      expect([...server.holders]).toEqual(on ? [[MOCK_PUSH_TOKEN, "Bearer access-2"]] : []);
      expect(await stored()).toEqual({ token: MOCK_PUSH_TOKEN, owed: on });
    });
  });

  it("the device marks the removal owed until the server confirms it", async () => {
    const server = deviceServer();
    await offlineLogoutOfA(server);
    expect(await stored()).toEqual({ token: MOCK_PUSH_TOKEN, owed: true });

    restart();
    await signInAs(userA);
    await syncPushToken();
    await logout(); // online this time

    expect(await stored()).toEqual({ token: MOCK_PUSH_TOKEN, owed: false });
    expect(server.holders.size).toBe(0);
  });

  it("after a restart, a rotated token: the old one moves to B and comes off it, then the new one registers", async () => {
    const server = deviceServer();
    await offlineLogoutOfA(server);
    restart();
    notifications.getExpoPushTokenAsync.mockResolvedValue({ type: "expo", data: ROTATED });
    await signInAs(userB);
    const before = deviceCalls().length;

    await syncPushToken();

    expect(deviceCalls().slice(before)).toEqual([
      {
        method: "PUT",
        auth: "Bearer access-2",
        body: { expo_push_token: MOCK_PUSH_TOKEN, platform: Platform.OS },
      },
      { method: "DELETE", auth: "Bearer access-2", body: { expo_push_token: MOCK_PUSH_TOKEN } },
      {
        method: "PUT",
        auth: "Bearer access-2",
        body: { expo_push_token: ROTATED, platform: Platform.OS },
      },
    ]);
    expect([...server.holders]).toEqual([[ROTATED, "Bearer access-2"]]);
  });

  it("after a restart, A signs back in: the token is A's again, sent once", async () => {
    const server = deviceServer();
    await offlineLogoutOfA(server);
    restart();
    await signInAs(userA);
    const before = deviceCalls().length;

    await syncPushToken();

    expect(deviceCalls().slice(before)).toEqual([
      {
        method: "PUT",
        auth: "Bearer access-2",
        body: { expo_push_token: MOCK_PUSH_TOKEN, platform: Platform.OS },
      },
    ]);
    expect(server.holders.get(MOCK_PUSH_TOKEN)).toBe("Bearer access-2");
  });

  it("after a restart, B signs in with notifications off: the token moves to B and comes off it", async () => {
    const server = deviceServer();
    await offlineLogoutOfA(server);
    restart();
    notifications.getPermissionsAsync.mockImplementation(async () => permission("denied", false));
    await signInAs(userB);
    const before = deviceCalls().length;

    await expect(settleOwedPushToken()).resolves.toBe(true);

    expect(deviceCalls().slice(before)).toEqual([
      {
        method: "PUT",
        auth: "Bearer access-2",
        body: { expo_push_token: MOCK_PUSH_TOKEN, platform: Platform.OS },
      },
      { method: "DELETE", auth: "Bearer access-2", body: { expo_push_token: MOCK_PUSH_TOKEN } },
    ]);
    expect(server.holders.size).toBe(0);
    expect(await stored()).toEqual({ token: MOCK_PUSH_TOKEN, owed: false });
    expect(notifications.getExpoPushTokenAsync).toHaveBeenCalledTimes(1); // A's sign-in only
  });

  it("notifications turned on while the settle was queued: the token moves to B and stays", async () => {
    const server = deviceServer();
    await offlineLogoutOfA(server);
    restart();
    await signInAs(userB); // the hook saw them off; they are on by the time the settle runs

    await expect(settleOwedPushToken()).resolves.toBe(true);

    expect(server.holders.get(MOCK_PUSH_TOKEN)).toBe("Bearer access-2");
    expect(deviceCalls().at(-1)?.method).toBe("PUT");
  });

  it("nothing owed (A's removal landed): the next account with notifications off sends nothing", async () => {
    deviceServer();
    await signInAs(userA);
    await syncPushToken();
    await logout();
    restart();
    notifications.getPermissionsAsync.mockImplementation(async () => permission("denied", false));
    await signInAs(userB);
    const before = deviceCalls().length;

    await expect(settleOwedPushToken()).resolves.toBe(true);

    expect(deviceCalls().slice(before)).toEqual([]);
  });

  it("offline again at B's sign-in: the move fails, stays owed, and lands on the next try", async () => {
    const server = deviceServer();
    await offlineLogoutOfA(server);
    restart();
    notifications.getPermissionsAsync.mockImplementation(async () => permission("denied", false));
    await signInAs(userB);
    server.setOffline(true);

    await expect(settleOwedPushToken()).resolves.toBe(false);
    // The PUT got no answer: it may have left the phone, and the record says so.
    expect(await stored()).toEqual({ token: MOCK_PUSH_TOKEN, owed: true, unanswered: true });
    expect(warnings()).toContain("Owed push token removal failed: NetworkError");

    server.setOffline(false);
    await expect(settleOwedPushToken()).resolves.toBe(true);
    expect(server.holders.size).toBe(0);
    // A confirmed removal settles both marks.
    expect(await stored()).toEqual({ token: MOCK_PUSH_TOKEN, owed: false });
  });

  it("settle: the move lands but its DELETE fails: still owed, and the retry sends the DELETE", async () => {
    const server = deviceServer();
    await offlineLogoutOfA(server);
    restart();
    notifications.getPermissionsAsync.mockImplementation(async () => permission("denied", false));
    await signInAs(userB);
    const reachable = routes["/v1/devices"];
    routes["/v1/devices"] = async (init) => {
      if (init?.method === "DELETE") throw new TypeError("Network request failed");
      return reachable(init);
    };

    await expect(settleOwedPushToken()).resolves.toBe(false);
    expect(server.holders.get(MOCK_PUSH_TOKEN)).toBe("Bearer access-2");
    expect(await stored()).toEqual({ token: MOCK_PUSH_TOKEN, owed: true });

    routes["/v1/devices"] = reachable;
    await expect(settleOwedPushToken()).resolves.toBe(true);

    expect(server.holders.size).toBe(0);
    expect(await stored()).toEqual({ token: MOCK_PUSH_TOKEN, owed: false });
  });

  it("the logout's bound runs out while a registration holds the queue: the token stays owed", async () => {
    const server = deviceServer();
    await signInAs(userA);
    await syncPushToken();
    const reachable = routes["/v1/devices"];
    const slowPut = deferred<void>();
    routes["/v1/devices"] = async (init) => {
      if (init?.method === "PUT") await slowPut.promise;
      return reachable(init);
    };
    jest.useFakeTimers();
    const sync = syncPushToken(); // its PUT is slow to answer
    const done = logout(); // the removal waits behind it
    await jest.advanceTimersByTimeAsync(3_000);
    await done;
    expect(sessionStore.getState().status).toBe("signedOut");

    slowPut.resolve(); // the server applied A's PUT; the app drops the answer
    await sync;
    await jest.advanceTimersByTimeAsync(0);
    jest.useRealTimers();

    // The skipped removal left the token owed: A still holds it on the server. The PUT the
    // logout cut off is recorded as unanswered.
    expect(server.holders.get(MOCK_PUSH_TOKEN)).toBe("Bearer access-1");
    expect(await stored()).toEqual({ token: MOCK_PUSH_TOKEN, owed: true, unanswered: true });

    restart();
    routes["/v1/devices"] = reachable;
    notifications.getPermissionsAsync.mockImplementation(async () => permission("denied", false));
    await signInAs(userB);
    await expect(settleOwedPushToken()).resolves.toBe(true);

    expect(server.holders.size).toBe(0);
  });

  it("B logs out while A's removal is still owed: the token moves to B first, then comes off", async () => {
    const server = deviceServer();
    await offlineLogoutOfA(server);
    restart();
    notifications.getPermissionsAsync.mockImplementation(async () => permission("denied", false));
    await signInAs(userB);
    server.setOffline(true);
    await settleOwedPushToken(); // fails: still owed
    server.setOffline(false);

    await logout();

    expect(server.holders.size).toBe(0);
    expect(await stored()).toEqual({ token: MOCK_PUSH_TOKEN, owed: false });
  });

  it("a logout after a restart removes the token sent before it, without asking Expo", async () => {
    const server = deviceServer();
    await signInAs(userA);
    await syncPushToken();
    restart(); // the session itself is restored from the device
    notifications.getExpoPushTokenAsync.mockClear().mockRejectedValue(new Error("no service"));
    armPushTokenRemoval();

    await logout();

    expect(notifications.getExpoPushTokenAsync).not.toHaveBeenCalled();
    expect(deviceCalls().at(-1)).toEqual({
      method: "DELETE",
      auth: "Bearer access-1",
      body: { expo_push_token: MOCK_PUSH_TOKEN },
    });
    expect(server.holders.size).toBe(0);
  });

  it.each([
    ["unreadable", "{not json"],
    ["of another shape", '{"token":7,"owed":true}'],
  ])(
    "a stored state that is %s counts as none: the token comes from Expo",
    async (_label, value) => {
      await secureStoreMock.setItemAsync(PUSH_TOKEN_KEY, value);
      await signInAs(userA);

      await syncPushToken();

      expect(notifications.getExpoPushTokenAsync).toHaveBeenCalled();
      expect(deviceCalls()).toEqual([
        {
          method: "PUT",
          auth: "Bearer access-1",
          body: { expo_push_token: MOCK_PUSH_TOKEN, platform: Platform.OS },
        },
      ]);
    },
  );

  it("a store that fails both ways: nothing is registered, the failure is logged by its class", async () => {
    const restoreReads = failReads(Infinity);
    const restoreWrites = failWrites(Infinity);
    try {
      await signInAs(userA);

      await expect(syncPushToken()).resolves.toBe(false);

      expect(deviceCalls()).toEqual([]);
      expect(warnings()).toEqual([
        "Push token registration failed: PushTokenStateError (E_STORE_READ)",
      ]);
    } finally {
      restoreReads();
      restoreWrites();
    }
  });

  // Round 4 (Vault B1): an acknowledged PUT is not proof of who holds the token while an earlier
  // PUT of it is unanswered. The doubt is on the device, so a restart does not lose it.
  it("a PUT that got no answer lands after the next account registered, across a restart: that account's logout still takes the token off", async () => {
    const server = deviceServer();
    const reachable = routes["/v1/devices"]!;
    await signInAs(userA);
    let landLate = (): void => undefined;
    routes["/v1/devices"] = async (init) => {
      // The request leaves the phone and its answer is lost; the server applies it later.
      landLate = () => void reachable(init);
      throw new TypeError("Network request failed");
    };
    await expect(syncPushToken()).resolves.toBe(false);
    await logout(); // offline too: nothing comes off
    expect(await stored()).toEqual({ token: MOCK_PUSH_TOKEN, owed: true, unanswered: true });

    restart(); // nothing in memory says a PUT is still out: only the device's record does
    routes["/v1/devices"] = reachable;
    await signInAs(userB);
    await expect(syncPushToken()).resolves.toBe(true);
    expect(server.holders.get(MOCK_PUSH_TOKEN)).toBe("Bearer access-2");
    // B's PUT was answered, which says nothing about A's: the record keeps the doubt.
    expect(await stored()).toEqual({ token: MOCK_PUSH_TOKEN, owed: true, unanswered: true });

    landLate();
    expect(server.holders.get(MOCK_PUSH_TOKEN)).toBe("Bearer access-1");

    await logout();

    // Registered again for B right before its DELETE, so the DELETE took a row that was B's.
    expect(deviceCalls().slice(-2)).toEqual([
      {
        method: "PUT",
        auth: "Bearer access-2",
        body: { expo_push_token: MOCK_PUSH_TOKEN, platform: Platform.OS },
      },
      { method: "DELETE", auth: "Bearer access-2", body: { expo_push_token: MOCK_PUSH_TOKEN } },
    ]);
    expect(server.holders.size).toBe(0);
    expect(await stored()).toEqual({ token: MOCK_PUSH_TOKEN, owed: false });
  });

  // Round 4 (Vault B2): a token Expo replaced stays on the device's record until the server
  // confirms its removal.
  it("a rotated token whose old one cannot be removed: the old one stays recorded, the new one registers, and the next try removes it", async () => {
    const server = deviceServer();
    const reachable = routes["/v1/devices"]!;
    await signInAs(userA);
    await syncPushToken();
    notifications.getExpoPushTokenAsync.mockResolvedValue({ type: "expo", data: ROTATED });
    routes["/v1/devices"] = async (init) => {
      if (init?.method === "DELETE") throw new TypeError("Network request failed");
      return reachable(init);
    };

    await expect(syncPushToken()).resolves.toBe(false);

    expect(server.holders.get(ROTATED)).toBe("Bearer access-1");
    expect(server.holders.get(MOCK_PUSH_TOKEN)).toBe("Bearer access-1");
    expect(await stored()).toEqual({ token: ROTATED, owed: true, retired: [MOCK_PUSH_TOKEN] });
    expect(warnings()).toEqual(["Old push token removal failed: NetworkError"]);

    routes["/v1/devices"] = reachable;
    await expect(syncPushToken()).resolves.toBe(true);

    expect([...server.holders]).toEqual([[ROTATED, "Bearer access-1"]]);
    expect(await stored()).toEqual({ token: ROTATED, owed: true });
  });

  describe("the app is killed between the rotation's record and the old token's removal", () => {
    /** A holds the old token; Expo rotates it; the process dies as the first request goes out. */
    async function killedMidRotation(server: ReturnType<typeof deviceServer>) {
      const reachable = routes["/v1/devices"]!;
      await signInAs(userA);
      await syncPushToken();
      notifications.getExpoPushTokenAsync.mockResolvedValue({ type: "expo", data: ROTATED });
      let atDeath: string | null = null;
      routes["/v1/devices"] = async () => {
        atDeath ??= await secureStoreMock.getItemAsync(PUSH_TOKEN_KEY);
        throw new TypeError("Network request failed"); // nothing reaches the server
      };
      await syncPushToken();
      // The kill: the device keeps what was written by then, and nothing written after.
      await secureStoreMock.setItemAsync(PUSH_TOKEN_KEY, atDeath!);
      restart();
      expect(await stored()).toEqual({
        token: ROTATED,
        owed: true,
        unanswered: true,
        retired: [MOCK_PUSH_TOKEN],
      });
      expect([...server.holders]).toEqual([[MOCK_PUSH_TOKEN, "Bearer access-1"]]);
      return reachable;
    }

    it("A comes back: the old token comes off, the new one registers", async () => {
      const server = deviceServer();
      routes["/v1/devices"] = await killedMidRotation(server);

      await expect(syncPushToken()).resolves.toBe(true);

      expect([...server.holders]).toEqual([[ROTATED, "Bearer access-1"]]);
      expect(await stored()).not.toHaveProperty("retired");
    });

    it("B signs in with notifications off: both tokens move to B and come off", async () => {
      const server = deviceServer();
      const reachable = await killedMidRotation(server);
      await logout(); // still unreachable: A's sign-out removes nothing
      routes["/v1/devices"] = reachable;
      notifications.getPermissionsAsync.mockImplementation(async () => permission("denied", false));
      await signInAs(userB);

      await expect(settleOwedPushToken()).resolves.toBe(true);

      expect(server.holders.size).toBe(0);
      expect(await stored()).toEqual({ token: ROTATED, owed: false });
    });
  });

  it("Expo goes back to a token retired earlier: it is the current one again and no longer a retired one", async () => {
    const server = deviceServer();
    const reachable = routes["/v1/devices"]!;
    await signInAs(userA);
    await syncPushToken();
    notifications.getExpoPushTokenAsync.mockResolvedValue({ type: "expo", data: ROTATED });
    routes["/v1/devices"] = async (init) => {
      if (init?.method === "DELETE") throw new TypeError("Network request failed");
      return reachable(init);
    };
    await expect(syncPushToken()).resolves.toBe(false);
    expect(await stored()).toEqual({ token: ROTATED, owed: true, retired: [MOCK_PUSH_TOKEN] });

    routes["/v1/devices"] = reachable;
    notifications.getExpoPushTokenAsync.mockResolvedValue({ type: "expo", data: MOCK_PUSH_TOKEN });
    await expect(syncPushToken()).resolves.toBe(true);

    expect([...server.holders]).toEqual([[MOCK_PUSH_TOKEN, "Bearer access-1"]]);
    // What became of its earlier PUTs is not known: the doubt stays until a removal is confirmed.
    expect(await stored()).toEqual({ token: MOCK_PUSH_TOKEN, owed: true, unanswered: true });
  });

  it("a logout that removes the current token but not a retired one: the next account, notifications off, takes the retired one off", async () => {
    const server = deviceServer();
    const reachable = routes["/v1/devices"]!;
    await signInAs(userA);
    await syncPushToken();
    notifications.getExpoPushTokenAsync.mockResolvedValue({ type: "expo", data: ROTATED });
    // Nothing about the old token reaches the server; the new one's requests do.
    routes["/v1/devices"] = async (init) => {
      const body = JSON.parse(String(init?.body)) as { expo_push_token: string };
      if (body.expo_push_token === MOCK_PUSH_TOKEN) throw new TypeError("Network request failed");
      return reachable(init);
    };
    await expect(syncPushToken()).resolves.toBe(false);

    await logout();

    expect([...server.holders]).toEqual([[MOCK_PUSH_TOKEN, "Bearer access-1"]]);
    expect(await stored()).toEqual({ token: ROTATED, owed: false, retired: [MOCK_PUSH_TOKEN] });

    restart();
    routes["/v1/devices"] = reachable;
    notifications.getPermissionsAsync.mockImplementation(async () => permission("denied", false));
    await signInAs(userB);
    await expect(settleOwedPushToken()).resolves.toBe(true);

    expect(server.holders.size).toBe(0);
    expect(await stored()).toEqual({ token: ROTATED, owed: false });
  });

  it("a logout that cannot read the record writes nothing over it: a retired token's mark is still there for the next sign-in", async () => {
    const server = deviceServer();
    const reachable = routes["/v1/devices"]!;
    await signInAs(userA);
    await syncPushToken();
    notifications.getExpoPushTokenAsync.mockResolvedValue({ type: "expo", data: ROTATED });
    routes["/v1/devices"] = async (init) => {
      if (init?.method === "DELETE") throw new TypeError("Network request failed");
      return reachable(init);
    };
    await expect(syncPushToken()).resolves.toBe(false);
    routes["/v1/devices"] = reachable;
    restart(); // A's session goes on; this process has not read the record yet
    armPushTokenRemoval();
    const sent = deviceCalls().length;
    const restore = failReads(Infinity);
    try {
      await logout();
    } finally {
      restore();
    }

    // Only the DELETE of Expo's current token went out; the old token's mark is untouched.
    expect(deviceCalls().slice(sent)).toEqual([
      { method: "DELETE", auth: "Bearer access-1", body: { expo_push_token: ROTATED } },
    ]);
    expect([...server.holders]).toEqual([[MOCK_PUSH_TOKEN, "Bearer access-1"]]);
    expect(await stored()).toEqual({ token: ROTATED, owed: true, retired: [MOCK_PUSH_TOKEN] });

    notifications.getPermissionsAsync.mockImplementation(async () => permission("denied", false));
    await signInAs(userB);
    await expect(settleOwedPushToken()).resolves.toBe(true);
    expect(server.holders.size).toBe(0);
    expect(await stored()).toEqual({ token: ROTATED, owed: false });
  });

  it("a record read back with marks it cannot use keeps the ones it can", async () => {
    const server = deviceServer();
    server.holders.set(MOCK_PUSH_TOKEN, "Bearer gone");
    server.holders.set(ROTATED, "Bearer gone");
    await secureStoreMock.setItemAsync(
      PUSH_TOKEN_KEY,
      JSON.stringify({
        token: MOCK_PUSH_TOKEN,
        owed: true,
        unanswered: "yes",
        retired: [ROTATED, 7, ""],
        extra: 1,
      }),
    );
    notifications.getPermissionsAsync.mockImplementation(async () => permission("denied", false));
    await signInAs(userA);

    await expect(settleOwedPushToken()).resolves.toBe(true);

    expect(server.holders.size).toBe(0);
    expect(await stored()).toEqual({ token: MOCK_PUSH_TOKEN, owed: false });
  });
});

// The Gatekeeper's round-two probes (#334 B1), as written: a logout cut off by its bound, killed
// before the old queue drains (and the drained control), and a session ended by an expired
// refresh token, each followed by a restart and another account with notifications off.
describe("Gatekeeper334 durable removal boundaries round two", () => {
  function server() {
    const holders = new Map<string, string>();
    let holdPut = false;
    const entered = deferred<void>();
    const release = deferred<void>();
    routes["/v1/devices"] = async (init) => {
      const auth = new Headers(init?.headers).get("Authorization") ?? "";
      const { expo_push_token: token } = JSON.parse(String(init?.body)) as {
        expo_push_token: string;
      };
      if (init?.method === "PUT") {
        holders.set(token, auth);
        if (holdPut) {
          entered.resolve();
          await release.promise;
        }
      }
      if (init?.method === "DELETE" && holders.get(token) === auth) holders.delete(token);
      return jsonResponse(204);
    };
    return {
      holders,
      entered,
      release,
      setHold: (value: boolean) => {
        holdPut = value;
      },
    };
  }

  it.each([true, false])(
    "settles after timeout and restart; allow old queue to drain before kill=%s",
    async (drain) => {
      const api = server();
      await signInAs(userA);
      await syncPushToken();
      expect(api.holders.get(MOCK_PUSH_TOKEN)).toBe("Bearer access-1");
      jest.useFakeTimers();
      api.setHold(true);
      const sync = syncPushToken();
      await api.entered.promise; // PUT committed at the server, its response is delayed.
      const done = logout();
      await jest.advanceTimersByTimeAsync(3_000);
      await done;
      expect(sessionStore.getState().status).toBe("signedOut");
      try {
        if (drain) {
          api.release.resolve();
          await sync;
          await jest.advanceTimersByTimeAsync(0);
        }
        // Process death now: volatile queue/cache disappear, secure storage remains as at death.
        // In the no-drain case old promises remain frozen until finally, after the assertion.
        resetPushTokenForTests();
        api.setHold(false);
        notifications.getPermissionsAsync.mockImplementation(async () =>
          permission("denied", false),
        );
        await signInAs(userB);
        await expect(settleOwedPushToken()).resolves.toBe(true);
        expect(api.holders.size).toBe(0);
      } finally {
        api.release.resolve();
        await sync;
        await jest.advanceTimersByTimeAsync(0);
      }
    },
  );

  it("settles A's token after server expiry, restart and B signing in with permission off", async () => {
    const api = server();
    await signInAs(userA);
    await syncPushToken();
    routes["/v1/auth/refresh"] = async () =>
      jsonResponse(401, { error: { code: "invalid_refresh_token" } });
    await expect(refreshSession()).rejects.toMatchObject({ name: "SessionExpiredError" });
    expect(sessionStore.getState().status).toBe("signedOut");
    expect(api.holders.get(MOCK_PUSH_TOKEN)).toBe("Bearer access-1");
    resetPushTokenForTests();
    notifications.getPermissionsAsync.mockImplementation(async () => permission("denied", false));
    await signInAs(userB);
    await expect(settleOwedPushToken()).resolves.toBe(true);
    expect(api.holders.size).toBe(0);
  });
});

// The Gatekeeper's round-three probes (#334 B1a, B1b), as written: one failed write of the owed
// mark before a registration, and one failed read of the record at the next account's sign-in,
// each with its control where the store does not fail.
describe("Gatekeeper334 round three storage recovery", () => {
  const KEY = "jackfixit.notifications.pushToken";
  function server() {
    const holders = new Map<string, string>();
    routes["/v1/devices"] = async (init) => {
      const auth = new Headers(init?.headers).get("Authorization") ?? "";
      const { expo_push_token: token } = JSON.parse(String(init?.body)) as {
        expo_push_token: string;
      };
      if (init?.method === "PUT") holders.set(token, auth);
      if (init?.method === "DELETE" && holders.get(token) === auth) holders.delete(token);
      return jsonResponse(204);
    };
    routes["/v1/auth/refresh"] = async () =>
      jsonResponse(401, { error: { code: "invalid_refresh_token" } });
    return holders;
  }
  async function expireA() {
    await expect(refreshSession()).rejects.toMatchObject({ name: "SessionExpiredError" });
    expect(sessionStore.getState().status).toBe("signedOut");
    resetPushTokenForTests();
    notifications.getPermissionsAsync.mockImplementation(async () => permission("denied", false));
    await signInAs(userB);
  }

  it.each([false, true])(
    "write-ahead failure=%s: A must not own the token after B signs in and settles",
    async (fail) => {
      const holders = server();
      // A prior confirmed removal leaves a legitimate owed:false record.
      await signInAs(userA);
      await syncPushToken();
      await logout();
      await signInAs(userA);
      const write = secureStoreMock.setItemAsync.getMockImplementation();
      let failOnce = fail;
      secureStoreMock.setItemAsync.mockImplementation(async (key: string, value: string) => {
        if (key === KEY && failOnce) {
          failOnce = false;
          throw new Error("keystore unavailable");
        }
        await write?.(key, value);
      });
      try {
        await syncPushToken();
        // Storage is healthy again before session expiry and B's sign-in.
      } finally {
        if (write) secureStoreMock.setItemAsync.mockImplementation(write);
      }
      await expireA();
      await settleOwedPushToken();
      expect([...holders]).toEqual([]);
    },
  );

  it.each([false, true])(
    "transient read failure=%s: B sign-in retries after storage recovers",
    async (fail) => {
      const holders = server();
      await signInAs(userA);
      await syncPushToken();
      await expireA();
      const read = secureStoreMock.getItemAsync.getMockImplementation();
      let failOnce = fail;
      secureStoreMock.getItemAsync.mockImplementation(async (key: string) => {
        if (key === KEY && failOnce) {
          failOnce = false;
          throw new Error("keystore unavailable");
        }
        return read ? read(key) : null;
      });
      try {
        await settleOwedPushToken();
      } finally {
        if (read) secureStoreMock.getItemAsync.mockImplementation(read);
      }
      // Even an explicit foreground retry with a now-readable record must reconcile A's token.
      await settleOwedPushToken();
      expect([...holders]).toEqual([]);
    },
  );
});

// The Vault's round 1 probes (#334), as written: nine scenarios against a server that keeps who
// holds each token. Two of them failed before round 4 (B1: a PUT that lands late; B2: a rotation
// whose DELETE fails).
describe("Vault334 independent ownership probes", () => {
  const key = "jackfixit.notifications.pushToken";
  const token2 = "ExponentPushToken[vault-rotated]";
  let owners: Map<string, string>;
  let failDeletes: boolean;
  let server: Route;

  beforeEach(() => {
    owners = new Map();
    failDeletes = false;
    server = async (init) => {
      const token = JSON.parse(String(init?.body)).expo_push_token as string;
      const owner = (init?.headers as Record<string, string>).Authorization;
      if (init?.method === "PUT") owners.set(token, owner);
      if (init?.method === "DELETE") {
        if (failDeletes) throw new TypeError("offline");
        if (owners.get(token) === owner) owners.delete(token);
      }
      return jsonResponse(204);
    };
    routes["/v1/devices"] = (init) => server(init);
  });

  async function restartWithBOff() {
    resetPushTokenForTests();
    resetPermissionForTests();
    notifications.getPermissionsAsync.mockImplementation(async () => permission("denied"));
    await signInAs(userB);
    expect(await settleOwedPushToken()).toBe(true);
  }

  it("control: failed logout then restart and B off removes A's token", async () => {
    await signInAs(userA);
    expect(await syncPushToken()).toBe(true);
    failDeletes = true;
    await logout();
    expect(owners.get(MOCK_PUSH_TOKEN)).toBe("Bearer access-1");
    failDeletes = false;
    await restartWithBOff();
    expect(owners.size).toBe(0);
  });

  it("a failed DELETE during rotation cannot erase the old removal debt", async () => {
    await signInAs(userA);
    expect(await syncPushToken()).toBe(true);
    notifications.getExpoPushTokenAsync.mockResolvedValue({ type: "expo", data: token2 });
    failDeletes = true;
    await syncPushToken();
    await logout();
    failDeletes = false;
    await restartWithBOff();
    expect(owners.get(token2)).toBeUndefined();
    expect(owners.get(MOCK_PUSH_TOKEN)).toBeUndefined();
  });

  it("control: successful rotation DELETE survives restart and B off", async () => {
    await signInAs(userA);
    expect(await syncPushToken()).toBe(true);
    notifications.getExpoPushTokenAsync.mockResolvedValue({ type: "expo", data: token2 });
    expect(await syncPushToken()).toBe(true);
    failDeletes = true;
    await logout();
    failDeletes = false;
    await restartWithBOff();
    expect(owners.size).toBe(0);
  });

  it.each(["before B moves", "after B moves"])(
    "timed-out A PUT commits %s: B logout and next settlement remove A",
    async (when) => {
      jest.useFakeTimers();
      await signInAs(userA);
      let lateCommit: (() => void) | undefined;
      routes["/v1/devices"] = async (init) => {
        if (!lateCommit && init?.method === "PUT") {
          const token = JSON.parse(String(init.body)).expo_push_token;
          const owner = (init.headers as Record<string, string>).Authorization;
          lateCommit = () => {
            owners.set(token, owner);
          };
          return new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          });
        }
        return server(init);
      };
      const registration = syncPushToken();
      await jest.advanceTimersByTimeAsync(0);
      expect(lateCommit).toBeDefined();
      const out = logout();
      await jest.advanceTimersByTimeAsync(3_000);
      await out;
      await signInAs(userB);
      if (when === "before B moves") lateCommit!();
      const bRegistration = syncPushToken();
      await jest.advanceTimersByTimeAsync(15_000);
      await registration;
      expect(await bRegistration).toBe(true);
      expect(owners.get(MOCK_PUSH_TOKEN)).toBe("Bearer access-2");
      if (when === "after B moves") lateCommit!();
      await logout();
      expect(JSON.parse((await secureStoreMock.getItemAsync(key))!)).toEqual({
        token: MOCK_PUSH_TOKEN,
        owed: false,
      });
      await restartWithBOff();
      expect(owners.get(MOCK_PUSH_TOKEN)).toBeUndefined();
    },
  );

  it("transient SecureStore read failure at handoff sends nothing, then retry removes A", async () => {
    await signInAs(userA);
    await syncPushToken();
    failDeletes = true;
    await logout();
    failDeletes = false;
    resetPushTokenForTests();
    await signInAs(userB);
    notifications.getPermissionsAsync.mockImplementation(async () => permission("denied"));
    secureStoreMock.getItemAsync.mockRejectedValueOnce(new Error("storage unreadable"));
    const before = deviceCalls().length;
    expect(await settleOwedPushToken()).toBe(false);
    expect(deviceCalls().length).toBe(before);
    expect(await settleOwedPushToken()).toBe(true);
    expect(owners.size).toBe(0);
  });

  it("failed SecureStore write stops registration and remains retryable", async () => {
    await signInAs(userA);
    secureStoreMock.setItemAsync.mockRejectedValueOnce(
      new Error("write failed ExponentPushToken[do-not-log]"),
    );
    expect(await syncPushToken()).toBe(false);
    expect(deviceCalls()).toEqual([]);
    expect(await syncPushToken()).toBe(true);
    expect(owners.get(MOCK_PUSH_TOKEN)).toBe("Bearer access-1");
    const stored = JSON.parse((await secureStoreMock.getItemAsync(key))!);
    expect(stored).toEqual({ token: MOCK_PUSH_TOKEN, owed: true });
  });

  it("401 DELETE with refused refresh leaves debt; B settles it without signing B out", async () => {
    await signInAs(userA);
    expect(await syncPushToken()).toBe(true);
    routes["/v1/devices"] = async () => jsonResponse(401, { error: { code: "invalid_token" } });
    routes["/v1/auth/refresh"] = async () =>
      jsonResponse(401, { error: { code: "invalid_token" } });
    await logout();
    expect(JSON.parse((await secureStoreMock.getItemAsync(key))!).owed).toBe(true);
    routes["/v1/devices"] = (init) => server(init);
    await restartWithBOff();
    expect(owners.size).toBe(0);
    expect(sessionStore.getState().user?.id).toBe(userB.id);
  });

  it("request payload and query cache contain no account PII or push token keys", async () => {
    await signInAs(userA);
    await syncPushToken();
    const call = fetchMock.mock.calls.find((c) => callPath(c) === "/v1/devices")!;
    expect(new URL(call[0]).search).toBe("");
    expect(callBody(call)).toEqual({ expo_push_token: MOCK_PUSH_TOKEN, platform: Platform.OS });
    expect(JSON.stringify(queryClient.getQueryCache().getAll())).not.toContain(MOCK_PUSH_TOKEN);
    expect(notifications.requestPermissionsAsync).not.toHaveBeenCalled();
  });
});
