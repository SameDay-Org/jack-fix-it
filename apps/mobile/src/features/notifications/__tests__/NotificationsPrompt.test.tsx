import "@/i18n";

import { act, fireEvent, render, screen } from "@testing-library/react-native";

import { resetSecureStore, secureStoreMock } from "../../../api/__tests__/helpers";
import { NotificationsPrompt } from "../NotificationsPrompt";
import { refreshPermission, resetPermissionForTests } from "../permission";
import { resetPromptDismissalForTests } from "../promptDismissal";

jest.mock("expo-notifications");
jest.mock(
  "../../../api/config",
  () => jest.requireActual("../../../api/__tests__/helpers").configMock,
);
jest.mock(
  "expo-secure-store",
  () => jest.requireActual("../../../api/__tests__/helpers").secureStoreMock,
);

const notifications =
  jest.requireMock<typeof import("../../../../__mocks__/expo-notifications")>("expo-notifications");
const { permission } = notifications;
const DISMISSED_KEY = "jackfixit.notifications.promptDismissed";

async function show(audience: "customer" | "pro" = "customer"): Promise<void> {
  await act(async () => {
    await refreshPermission();
  });
  await render(<NotificationsPrompt audience={audience} testID="prompt" />);
}

beforeEach(() => {
  notifications.resetNotificationsMock();
  resetPermissionForTests();
  resetPromptDismissalForTests();
  resetSecureStore();
});

describe("NotificationsPrompt", () => {
  it.each([
    ["customer", "Get updates when your pro is on the way."],
    ["pro", "Hear about new jobs near you, and when a customer hires you."],
  ] as const)(
    "asks the %s first, in the app's words, without the system prompt",
    async (audience, body) => {
      await show(audience);

      expect(await screen.findByText("Turn on notifications")).toBeTruthy();
      expect(screen.getByText(body)).toBeTruthy();
      expect(screen.getByRole("header", { name: "Turn on notifications" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Turn on" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Not now" })).toBeTruthy();
      expect(notifications.requestPermissionsAsync).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["granted", permission("granted")],
    ["blocked (denied for good)", permission("denied", false)],
  ])("stays hidden when notifications are %s", async (_label, answer) => {
    notifications.getPermissionsAsync.mockResolvedValue(answer);
    await show();
    await act(async () => undefined);

    expect(screen.queryByTestId("prompt")).toBeNull();
  });

  it("stays hidden before the permission is known", async () => {
    await render(<NotificationsPrompt audience="customer" testID="prompt" />);
    await act(async () => undefined);

    expect(screen.queryByTestId("prompt")).toBeNull();
  });

  it("stays hidden once closed on this device", async () => {
    await secureStoreMock.setItemAsync(DISMISSED_KEY, "1");
    await show();
    await act(async () => undefined);

    expect(screen.queryByTestId("prompt")).toBeNull();
    expect(secureStoreMock.getItemAsync).toHaveBeenCalledWith(DISMISSED_KEY);
  });

  it("Turn on shows the system prompt once; granted, the card goes", async () => {
    await show();
    await screen.findByTestId("prompt");

    await act(async () => fireEvent.press(screen.getByTestId("prompt-turn-on")));

    expect(notifications.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("prompt")).toBeNull();
  });

  it("denied from the system prompt, the card does not come back (no repeated prompts)", async () => {
    // Android 13's first denial still allows another ask; the card is closed anyway.
    notifications.requestPermissionsAsync.mockResolvedValue(permission("denied", true));
    await show();
    await screen.findByTestId("prompt");

    await act(async () => fireEvent.press(screen.getByTestId("prompt-turn-on")));

    expect(screen.queryByTestId("prompt")).toBeNull();
    expect(secureStoreMock.setItemAsync).toHaveBeenCalledWith(DISMISSED_KEY, "1", {
      keychainAccessible: "afterFirstUnlockThisDeviceOnly",
    });
  });

  it("Not now closes it for good on this device and never asks", async () => {
    await show();
    await screen.findByTestId("prompt");

    await act(async () => fireEvent.press(screen.getByTestId("prompt-not-now")));

    expect(screen.queryByTestId("prompt")).toBeNull();
    expect(secureStoreMock.setItemAsync).toHaveBeenCalledWith(DISMISSED_KEY, "1", {
      keychainAccessible: "afterFirstUnlockThisDeviceOnly",
    });
    expect(notifications.requestPermissionsAsync).not.toHaveBeenCalled();
  });
});
