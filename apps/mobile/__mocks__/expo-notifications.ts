// Manual Jest mock, applied to every suite (root __mocks__): the real enums and constants, the
// native calls as jest.fn. By default notifications were never asked for (the system prompt can
// still appear), asking grants them, and Expo issues `MOCK_PUSH_TOKEN`. A suite that drives these
// declares `jest.mock("expo-notifications")` so its import and `jest.requireMock` share one
// instance, and calls `resetNotificationsMock()` in `beforeEach`.
import type * as NotificationsModule from "expo-notifications";

// The enums from their own files: the package's entry warns about Expo Go on import.
export const { AndroidImportance } = jest.requireActual<
  Pick<typeof NotificationsModule, "AndroidImportance">
>("expo-notifications/build/NotificationChannelManager.types");
export const { IosAuthorizationStatus } = jest.requireActual<
  Pick<typeof NotificationsModule, "IosAuthorizationStatus">
>("expo-notifications/build/NotificationPermissions.types");
export const DEFAULT_ACTION_IDENTIFIER: typeof NotificationsModule.DEFAULT_ACTION_IDENTIFIER =
  "expo.modules.notifications.actions.DEFAULT";

export const MOCK_PUSH_TOKEN = "ExponentPushToken[mock-device-1]";

type Permission = NotificationsModule.NotificationPermissionsStatus;
type Subscription = { remove: jest.Mock };

/** A permission answer as the module gives it. */
export function permission(
  status: "granted" | "denied" | "undetermined",
  canAskAgain = status !== "denied",
  ios?: { status: NotificationsModule.IosAuthorizationStatus },
): Permission {
  return {
    status: status as Permission["status"],
    granted: status === "granted",
    canAskAgain,
    expires: "never",
    ...(ios ? { ios: ios as Permission["ios"] } : {}),
  };
}

export const getPermissionsAsync = jest.fn(async (): Promise<Permission> =>
  permission("undetermined"),
);
export const requestPermissionsAsync = jest.fn(async (): Promise<Permission> =>
  permission("granted"),
);
export const setNotificationChannelAsync = jest.fn(async () => null);
export const getExpoPushTokenAsync = jest.fn(
  async (_options?: NotificationsModule.ExpoPushTokenOptions) => ({
    type: "expo" as const,
    data: MOCK_PUSH_TOKEN,
  }),
);

/** The push-token listeners currently subscribed; `emitPushToken()` calls each. */
export const pushTokenListeners = new Set<NotificationsModule.PushTokenListener>();
export const addPushTokenListener = jest.fn(
  (listener: NotificationsModule.PushTokenListener): Subscription => {
    pushTokenListeners.add(listener);
    return { remove: jest.fn(() => pushTokenListeners.delete(listener)) };
  },
);

/** The device's push token changed, as the OS reports it. */
export function emitPushToken(data = "device-token-2"): void {
  for (const listener of [...pushTokenListeners]) listener({ type: "android", data });
}

export const addNotificationResponseReceivedListener = jest.fn((): Subscription => ({
  remove: jest.fn(),
}));
export const getLastNotificationResponse = jest.fn(() => null);
export const clearLastNotificationResponse = jest.fn();

/** Back to the defaults above, with every call forgotten. */
export function resetNotificationsMock(): void {
  getPermissionsAsync.mockReset().mockImplementation(async () => permission("undetermined"));
  requestPermissionsAsync.mockReset().mockImplementation(async () => permission("granted"));
  setNotificationChannelAsync.mockReset().mockImplementation(async () => null);
  getExpoPushTokenAsync
    .mockReset()
    .mockImplementation(async () => ({ type: "expo" as const, data: MOCK_PUSH_TOKEN }));
  addPushTokenListener.mockClear();
  pushTokenListeners.clear();
  addNotificationResponseReceivedListener.mockClear();
  getLastNotificationResponse.mockClear();
  clearLastNotificationResponse.mockClear();
}
