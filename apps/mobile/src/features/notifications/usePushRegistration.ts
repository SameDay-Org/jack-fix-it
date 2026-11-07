import * as Notifications from "expo-notifications";
import { useEffect } from "react";
import { AppState } from "react-native";

import { useSession } from "@/api";

import { refreshPermission, useNotificationPermission } from "./permission";
import { syncPushToken } from "./pushToken";

/**
 * Keeps this device's push token registered for the signed-in customer or pro (#334), from the
 * signed-in layout: at each sign-in and app start, when notifications turn on (from the pre-prompt,
 * Settings, or the phone's settings on return to the app) and when the token changes. Reads the
 * permission, never asks for it.
 */
export function usePushRegistration(): void {
  const { user } = useSession();
  const permission = useNotificationPermission();
  const userId = user?.id;
  // Only customers and pros receive pushes; the API refuses any other role.
  const eligible = user?.role === "customer" || user?.role === "pro";
  const granted = permission === "granted";

  useEffect(() => {
    void refreshPermission();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void refreshPermission();
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (!eligible || !granted || !userId) return;
    void syncPushToken();
    const subscription = Notifications.addPushTokenListener(() => void syncPushToken());
    return () => subscription.remove();
  }, [eligible, granted, userId]);
}
