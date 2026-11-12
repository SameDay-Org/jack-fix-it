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
jest.mock("../pushToken", () => ({
  armPushTokenRemoval: jest.fn(),
  settleOwedPushToken: jest.fn(async () => true),
  syncPushToken: jest.fn(async () => true),
}));

const notifications =
  jest.requireMock<typeof import("../../../../__mocks__/expo-notifications")>("expo-notifications");
const { armPushTokenRemoval, settleOwedPushToken, syncPushToken } = jest.requireMock<{
  armPushTokenRemoval: jest.Mock;
  settleOwedPushToken: jest.Mock;
  syncPushToken: jest.Mock;
}>("../pushToken");
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
  syncPushToken.mockReset().mockResolvedValue(true);
  settleOwedPushToken.mockReset().mockResolvedValue(true);
  armPushTokenRemoval.mockClear();
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
    expect(settleOwedPushToken).not.toHaveBeenCalled();
    expect(notifications.addPushTokenListener).not.toHaveBeenCalled();
    expect(armPushTokenRemoval).not.toHaveBeenCalled();
  });

  it("arms the removal at sign-in, before any token is fetched (a logout right after start)", async () => {
    await renderHook(() => usePushRegistration());

    expect(armPushTokenRemoval).toHaveBeenCalled();
    expect(syncPushToken).not.toHaveBeenCalled();
  });

  it("a failed registration is tried again on the next return to the app, once", async () => {
    notifications.getPermissionsAsync.mockResolvedValue(permission("granted"));
    syncPushToken.mockResolvedValueOnce(false);
    await renderHook(() => usePushRegistration());
    await act(async () => undefined);
    expect(syncPushToken).toHaveBeenCalledTimes(1);

    await foreground();
    expect(syncPushToken).toHaveBeenCalledTimes(2);

    // That one landed: the next return asks nothing more.
    await foreground();
    expect(syncPushToken).toHaveBeenCalledTimes(2);
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

describe("usePushRegistration with notifications off (#334 B1)", () => {
  it.each([
    ["never asked", permission("undetermined")],
    ["blocked", permission("denied", false)],
  ])("%s: settles a removal a previous account owes, registers nothing", async (_label, answer) => {
    notifications.getPermissionsAsync.mockResolvedValue(answer);
    const hook = await renderHook(() => usePushRegistration());
    await act(async () => undefined);

    expect(settleOwedPushToken).toHaveBeenCalledTimes(1);
    expect(syncPushToken).not.toHaveBeenCalled();

    // Each new account settles it too.
    mockSession.current = {
      ...mockSession.current,
      user: { ...user, id: "22222222-2222-4222-8222-222222222222", role: "pro" },
    };
    await hook.rerender({});
    await act(async () => undefined);
    expect(settleOwedPushToken).toHaveBeenCalledTimes(2);
  });

  it("before the permission is read nothing is sent", async () => {
    notifications.getPermissionsAsync.mockReturnValue(new Promise(() => undefined));
    await renderHook(() => usePushRegistration());
    await act(async () => undefined);

    expect(settleOwedPushToken).not.toHaveBeenCalled();
    expect(syncPushToken).not.toHaveBeenCalled();
  });

  it("a failed settle is tried again on the next return to the app, once", async () => {
    notifications.getPermissionsAsync.mockResolvedValue(permission("denied", false));
    settleOwedPushToken.mockResolvedValueOnce(false);
    await renderHook(() => usePushRegistration());
    await act(async () => undefined);
    expect(settleOwedPushToken).toHaveBeenCalledTimes(1);

    await foreground();
    expect(settleOwedPushToken).toHaveBeenCalledTimes(2);

    await foreground();
    expect(settleOwedPushToken).toHaveBeenCalledTimes(2);
  });

  it("turned on later: registers, and settles no more", async () => {
    notifications.getPermissionsAsync.mockResolvedValue(permission("denied", false));
    settleOwedPushToken.mockResolvedValueOnce(false);
    await renderHook(() => usePushRegistration());
    await act(async () => undefined);

    notifications.getPermissionsAsync.mockResolvedValue(permission("granted"));
    await foreground();

    expect(syncPushToken).toHaveBeenCalledTimes(1);
    // That return still ran the failed settle's retry (it re-reads the permission, and keeps the
    // token once they are on); nothing settles after that.
    const settles = settleOwedPushToken.mock.calls.length;
    await foreground();
    expect(settleOwedPushToken).toHaveBeenCalledTimes(settles);
  });
});
