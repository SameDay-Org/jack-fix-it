import * as Notifications from "expo-notifications";
import { useEffect, useRef } from "react";
import { AppState } from "react-native";

import { useSession } from "@/api";

import { refreshPermission, useNotificationPermission } from "./permission";
import { armPushTokenRemoval, settleOwedPushToken, syncPushToken } from "./pushToken";

/**
 * Keeps this device's push token registered for the signed-in customer or pro (#334), from the
 * signed-in layout: at each sign-in and app start, when notifications turn on (from the pre-prompt,
 * Settings, or the phone's settings on return to the app) and when the token changes. With
 * notifications off, it only settles a removal still owed (by an account that signed out, or by
 * this one from before they went off). Reads the permission, never asks for it.
 */
export function usePushRegistration(): void {
  const { user } = useSession();
  const permission = useNotificationPermission();
  const userId = user?.id;
  // Only customers and pros receive pushes; the API refuses any other role.
  const eligible = user?.role === "customer" || user?.role === "pro";
  const granted = permission === "granted";
  const active = eligible && granted && userId !== undefined;
  // Read, and not on: a token a previous account still holds must not stay with it.
  const off =
    eligible && userId !== undefined && (permission === "askable" || permission === "blocked");
  // A registration that failed (offline, a server error) is tried again on the next return to the
  // app: until it lands, a previous account whose removal failed would keep this device.
  const retry = useRef<(() => void) | null>(null);

  useEffect(() => {
    // Every logout removes the token first, even one before this launch fetched it.
    if (eligible) armPushTokenRemoval();
  }, [eligible]);

  useEffect(() => {
    void refreshPermission();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      void refreshPermission();
      retry.current?.();
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (!active) return;
    let live = true;
    const sync = () => {
      retry.current = null;
      void syncPushToken().then((ok) => {
        if (live && !ok) retry.current = sync;
      });
    };
    sync();
    const subscription = Notifications.addPushTokenListener(sync);
    return () => {
      live = false;
      retry.current = null;
      subscription.remove();
    };
  }, [active, userId]);

  useEffect(() => {
    if (!off) return;
    let live = true;
    const settle = () => {
      retry.current = null;
      void settleOwedPushToken().then((ok) => {
        if (live && !ok) retry.current = settle;
      });
    };
    settle();
    return () => {
      live = false;
      retry.current = null;
    };
  }, [off, userId]);
}
