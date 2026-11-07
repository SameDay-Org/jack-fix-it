import "@/i18n";

import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { Linking } from "react-native";

import { NotificationsSettingRow } from "../NotificationsSettingRow";
import { refreshPermission, resetPermissionForTests } from "../permission";

jest.mock("expo-notifications");

const notifications =
  jest.requireMock<typeof import("../../../../__mocks__/expo-notifications")>("expo-notifications");
const { permission } = notifications;

let openSettings: jest.SpyInstance;

async function show(): Promise<void> {
  await act(async () => {
    await refreshPermission();
  });
  await render(<NotificationsSettingRow />);
}

beforeEach(() => {
  notifications.resetNotificationsMock();
  resetPermissionForTests();
  openSettings = jest.spyOn(Linking, "openSettings").mockResolvedValue(undefined);
});

afterEach(() => openSettings.mockRestore());

describe("NotificationsSettingRow", () => {
  it("never asked: says Off, and a tap shows the system prompt", async () => {
    await show();

    const row = screen.getByRole("button", { name: "Notifications, Off" });
    expect(row.props.accessibilityHint).toBe("Asks your phone to turn on notifications");
    await act(async () => fireEvent.press(row));

    expect(notifications.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Notifications, On" })).toBeTruthy();
    expect(openSettings).not.toHaveBeenCalled();
  });

  it("blocked: says so, and a tap opens the phone's settings", async () => {
    notifications.getPermissionsAsync.mockResolvedValue(permission("denied", false));
    await show();

    const row = screen.getByRole("button", { name: "Notifications, Off in your phone's settings" });
    expect(row.props.accessibilityHint).toBe("Opens your phone's settings");
    await act(async () => fireEvent.press(row));

    expect(openSettings).toHaveBeenCalledTimes(1);
    expect(notifications.requestPermissionsAsync).not.toHaveBeenCalled();
  });

  it("on: says On, and a tap opens the phone's settings to turn them off", async () => {
    notifications.getPermissionsAsync.mockResolvedValue(permission("granted"));
    await show();

    await act(async () =>
      fireEvent.press(screen.getByRole("button", { name: "Notifications, On" })),
    );

    expect(openSettings).toHaveBeenCalledTimes(1);
  });

  it("before the permission is known: the label alone, nothing to press", async () => {
    await render(<NotificationsSettingRow />);

    expect(screen.getByText("Notifications")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
