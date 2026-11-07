import { Platform } from "react-native";

import { readNotificationsConfig } from "../config";
import { refreshPermission, requestPermission, resetPermissionForTests } from "../permission";

jest.mock("expo-notifications");

const notifications =
  jest.requireMock<typeof import("../../../../__mocks__/expo-notifications")>("expo-notifications");
const { IosAuthorizationStatus, permission } = notifications;

beforeEach(() => {
  notifications.resetNotificationsMock();
  resetPermissionForTests();
  jest.spyOn(console, "warn").mockImplementation();
});

afterEach(() => jest.restoreAllMocks());

describe("permission", () => {
  it.each([
    ["granted", permission("granted"), "granted"],
    ["never asked", permission("undetermined"), "askable"],
    ["denied once on Android 13 (can ask again)", permission("denied", true), "askable"],
    ["denied for good", permission("denied", false), "blocked"],
    [
      "iOS provisional",
      permission("denied", false, { status: IosAuthorizationStatus.PROVISIONAL }),
      "granted",
    ],
  ] as const)("%s reads as %s", async (_label, answer, expected) => {
    notifications.getPermissionsAsync.mockResolvedValue(answer);

    await expect(refreshPermission()).resolves.toBe(expected);
  });

  it("a failed read keeps the last known value and logs the class only", async () => {
    notifications.getPermissionsAsync.mockResolvedValue(permission("granted"));
    await refreshPermission();
    notifications.getPermissionsAsync.mockRejectedValue(new TypeError("native gone"));

    await expect(refreshPermission()).resolves.toBe("granted");
    expect(console.warn).toHaveBeenCalledWith("Notification permission read failed: TypeError");
  });

  it("on Android the channel exists before the system prompt (Android 13 shows none without one)", async () => {
    const order: string[] = [];
    notifications.setNotificationChannelAsync.mockImplementation(async () => {
      order.push("channel");
      return null;
    });
    notifications.requestPermissionsAsync.mockImplementation(async () => {
      order.push("request");
      return permission("granted");
    });

    await expect(requestPermission()).resolves.toBe("granted");

    expect(order).toEqual(Platform.OS === "android" ? ["channel", "request"] : ["request"]);
  });
});

describe("readNotificationsConfig", () => {
  it("defaults the removal timeout and reads the EAS project id", () => {
    expect(
      readNotificationsConfig({
        removalTimeoutMs: undefined,
        extra: { eas: { projectId: "p-1" } },
      }),
    ).toEqual({
      removalTimeoutMs: 3_000,
      projectId: "p-1",
    });
  });

  it("takes the timeout from the environment and refuses a bad one", () => {
    expect(readNotificationsConfig({ removalTimeoutMs: "1500", extra: undefined })).toEqual({
      removalTimeoutMs: 1_500,
      projectId: undefined,
    });
    expect(() => readNotificationsConfig({ removalTimeoutMs: "0", extra: undefined })).toThrow(
      "EXPO_PUBLIC_PUSH_REMOVAL_TIMEOUT_MS must be a positive whole number",
    );
  });
});
