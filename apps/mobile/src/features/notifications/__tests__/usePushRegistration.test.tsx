import { act, renderHook } from "@testing-library/react-native";
import { AppState, type AppStateStatus } from "react-native";

import { user } from "../../../api/__tests__/helpers";
import { resetPermissionForTests } from "../permission";
import { usePushRegistration } from "../usePushRegistration";

type MockSession = ReturnType<typeof import("@/api").useSession>;

const mockSession: { current: MockSession } = {
  current: {
    status: "signedIn",
    user,
    cleanupPending: false,
    restoreFailure: null,
    onboardingUserId: null,
  },
};

jest.mock("expo-notifications");
jest.mock("@/api", () => ({ useSession: () => mockSession.current }));
jest.mock("../pushToken", () => ({ syncPushToken: jest.fn(async () => undefined) }));

const notifications =
  jest.requireMock<typeof import("../../../../__mocks__/expo-notifications")>("expo-notifications");
const { syncPushToken } = jest.requireMock<{ syncPushToken: jest.Mock }>("../pushToken");
const { permission } = notifications;
const addAppStateListener = AppState.addEventListener as jest.Mock;

/** The app comes back to the front, as after a visit to the phone's settings. */
async function foreground(): Promise<void> {
  const [, listener] = addAppStateListener.mock.calls.at(-1) as [
    string,
    (state: AppStateStatus) => void,
  ];
  await act(async () => listener("active"));
}

beforeEach(() => {
  notifications.resetNotificationsMock();
  resetPermissionForTests();
  syncPushToken.mockClear();
  addAppStateListener.mockClear();
  mockSession.current = { ...mockSession.current, user };
});

describe("usePushRegistration", () => {
  it("at launch it reads the permission but never asks for it", async () => {
    await renderHook(() => usePushRegistration());
    await act(async () => undefined);

    expect(notifications.getPermissionsAsync).toHaveBeenCalled();
    expect(notifications.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(syncPushToken).not.toHaveBeenCalled();
  });

  it("allowed: registers at sign-in and app start, and again for each new account", async () => {
    notifications.getPermissionsAsync.mockResolvedValue(permission("granted"));
    const hook = await renderHook(() => usePushRegistration());
    await act(async () => undefined);
    expect(syncPushToken).toHaveBeenCalledTimes(1);

    mockSession.current = {
      ...mockSession.current,
      user: { ...user, id: "22222222-2222-4222-8222-222222222222", role: "pro" },
    };
    await hook.rerender({});
    await act(async () => undefined);

    expect(syncPushToken).toHaveBeenCalledTimes(2);
  });

  it("registers once notifications are turned on in the phone's settings", async () => {
    notifications.getPermissionsAsync.mockResolvedValue(permission("denied", false));
    await renderHook(() => usePushRegistration());
    await act(async () => undefined);
    expect(syncPushToken).not.toHaveBeenCalled();

    notifications.getPermissionsAsync.mockResolvedValue(permission("granted"));
    await foreground();

    expect(syncPushToken).toHaveBeenCalledTimes(1);
  });

  it("registers the new token when the device's token changes", async () => {
    notifications.getPermissionsAsync.mockResolvedValue(permission("granted"));
    await renderHook(() => usePushRegistration());
    await act(async () => undefined);

    await act(async () => notifications.emitPushToken());

    expect(syncPushToken).toHaveBeenCalledTimes(2);
  });

  it("staff accounts receive no pushes: nothing is registered", async () => {
    notifications.getPermissionsAsync.mockResolvedValue(permission("granted"));
    mockSession.current = { ...mockSession.current, user: { ...user, role: "admin" } };
    await renderHook(() => usePushRegistration());
    await act(async () => undefined);

    expect(syncPushToken).not.toHaveBeenCalled();
    expect(notifications.addPushTokenListener).not.toHaveBeenCalled();
  });

  it("stops listening once the signed-in layout goes", async () => {
    notifications.getPermissionsAsync.mockResolvedValue(permission("granted"));
    const hook = await renderHook(() => usePushRegistration());
    await act(async () => undefined);

    await hook.unmount();

    expect(notifications.pushTokenListeners.size).toBe(0);
    expect(addAppStateListener.mock.results.at(-1)?.value.remove).toHaveBeenCalled();
  });
});
