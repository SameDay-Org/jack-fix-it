import * as Notifications from "expo-notifications";
import { AndroidImportance, IosAuthorizationStatus } from "expo-notifications";
import { Linking, Platform } from "react-native";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

import i18n from "@/i18n";

import { reportFailure } from "./report";

/**
 * Where the device stands on notifications for this app: `granted` (iOS provisional too),
 * `askable` (the system prompt can still be shown), `blocked` (only the phone's settings can turn
 * them on), or `unknown` until the first read.
 */
export type NotificationPermission = "unknown" | "granted" | "askable" | "blocked";

// Android 13+ shows the system prompt only once the app has a channel; the push service delivers
// a push without a channel id to this one.
const CHANNEL_ID = "default";

const permissionStore = createStore<{ status: NotificationPermission }>()(() => ({
  status: "unknown",
}));

/** The last known permission; screens re-render when it changes. */
export function useNotificationPermission(): NotificationPermission {
  return useStore(permissionStore, (state) => state.status);
}

function classify(
  response: Notifications.NotificationPermissionsStatus,
): Exclude<NotificationPermission, "unknown"> {
  if (response.granted) return "granted";
  const ios = response.ios?.status;
  if (ios === IosAuthorizationStatus.PROVISIONAL || ios === IosAuthorizationStatus.EPHEMERAL) {
    return "granted";
  }
  return response.canAskAgain ? "askable" : "blocked";
}

/**
 * Reads the permission without asking (at sign-in, on return from the phone's settings). A failed
 * read keeps the last known value.
 */
export async function refreshPermission(): Promise<NotificationPermission> {
  try {
    const status = classify(await Notifications.getPermissionsAsync());
    permissionStore.setState({ status });
    return status;
  } catch (error) {
    reportFailure("Notification permission read failed", error);
    return permissionStore.getState().status;
  }
}

/** Creates (or renames, after a language change) the app's channel. Android only; best effort. */
export async function ensureNotificationChannel(): Promise<void> {
  if (Platform.OS !== "android") return;
  try {
    await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
      name: i18n.t("notifications.channel"),
      importance: AndroidImportance.DEFAULT,
    });
  } catch (error) {
    reportFailure("Notification channel setup failed", error);
  }
}

/**
 * Shows the system prompt. Only from a person's tap (the pre-prompt's "Turn on", the Settings
 * row), never at launch. Resolves to where the device stands afterwards.
 */
export async function requestPermission(): Promise<NotificationPermission> {
  await ensureNotificationChannel();
  try {
    const status = classify(await Notifications.requestPermissionsAsync());
    permissionStore.setState({ status });
    return status;
  } catch (error) {
    reportFailure("Notification permission request failed", error);
    return refreshPermission();
  }
}

/** Opens this app's page in the phone's settings, where blocked notifications are turned on. */
export function openNotificationSettings(): Promise<void> {
  return Linking.openSettings().catch((error: unknown) => {
    reportFailure("Opening the phone's settings failed", error);
  });
}

/** Forgets the last read. Tests only. */
export function resetPermissionForTests(): void {
  permissionStore.setState({ status: "unknown" });
}
