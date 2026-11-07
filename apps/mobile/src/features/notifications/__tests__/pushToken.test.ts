import type { ApiSchema } from "@jack/shared";
import { QueryClient } from "@tanstack/react-query";
import { Platform } from "react-native";

import { attachQueryClient, login, logout, sessionStore } from "../../../api/session";
import {
  authResponse,
  callBody,
  callHeader,
  callPath,
  deferred,
  installFetchMock,
  jsonResponse,
  resetSecureStore,
  user as userA,
  watchConsole,
  type FetchMock,
} from "../../../api/__tests__/helpers";
import { resetPermissionForTests } from "../permission";
import {
  armPushTokenRemoval,
  removePushToken,
  resetPushTokenForTests,
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

    expect(deviceCalls()).toEqual([
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
