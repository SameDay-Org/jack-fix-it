import * as Location from "expo-location";
import { useCallback, useEffect, useState } from "react";
import { AppState, Linking } from "react-native";

/**
 * The location permission as check-in needs it (while the app is in use, never in the
 * background):
 * - `unknown`: not read yet;
 * - `granted`;
 * - `askable`: never answered, or refused where the system will ask again (Android after one
 *   refusal), so the app explains first and then asks;
 * - `blocked`: refused for good; only the device settings can turn it on.
 */
export type LocationAccess = "unknown" | "granted" | "askable" | "blocked";

const accessOf = ({ granted, canAskAgain }: Location.LocationPermissionResponse): LocationAccess =>
  granted ? "granted" : canAskAgain ? "askable" : "blocked";

/**
 * The foreground location permission, read on mount and again whenever the app comes back to the
 * foreground (a grant made in Settings reaches the open sheet; reading never prompts). `ask`
 * shows the system prompt and answers whether access was granted. Nothing about the place is read
 * here.
 */
export function useLocationAccess() {
  const [access, setAccess] = useState<LocationAccess>("unknown");

  useEffect(() => {
    let live = true;
    const read = () =>
      Location.getForegroundPermissionsAsync().then(
        (response) => live && setAccess(accessOf(response)),
        () => live && setAccess("askable"),
      );
    void read();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void read();
    });
    return () => {
      live = false;
      subscription.remove();
    };
  }, []);

  const ask = useCallback(async (): Promise<boolean> => {
    try {
      const next = accessOf(await Location.requestForegroundPermissionsAsync());
      setAccess(next);
      return next === "granted";
    } catch {
      setAccess("blocked");
      return false;
    }
  }, []);

  const openSettings = useCallback(() => void Linking.openSettings(), []);

  return { access, ask, openSettings };
}

/** Where the pro is, for one check-in: sent with it, never kept on the device or logged. */
export type CheckInPosition = { lat: number; lng: number };

/**
 * Why no position came back: `timeout` (no fix in time: a calm retry), `off` (the device's
 * location is switched off, or the pro declined to turn it on), `denied` (no permission),
 * `failed` (anything else the system reported).
 */
export type LocationFailure = "timeout" | "off" | "denied" | "failed";

export class LocationUnavailableError extends Error {
  constructor(readonly reason: LocationFailure) {
    super(`The location is not available (${reason})`);
    this.name = "LocationUnavailableError";
  }
}

// expo-location's error codes for a device whose location is off (Android asks to turn it on
// first; declining ends in the second).
const LOCATION_OFF = new Set(["E_LOCATION_SERVICES_DISABLED", "E_LOCATION_SETTINGS_UNSATISFIED"]);
const NO_PERMISSION = new Set(["E_LOCATION_UNAUTHORIZED", "E_NO_PERMISSIONS"]);

function failureOf(error: unknown): LocationFailure {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code !== "string") return "failed";
  if (LOCATION_OFF.has(code)) return "off";
  if (NO_PERMISSION.has(code)) return "denied";
  return "failed";
}

/**
 * The phone's position right now, once, at the accuracy a check-in needs (a street, not a room),
 * or a `LocationUnavailableError` after `timeoutMs`. A fix that comes after the deadline is
 * dropped. The caller holds the permission already.
 */
export function currentPosition(timeoutMs: number): Promise<CheckInPosition> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(new LocationUnavailableError("timeout"));
    }, timeoutMs);
    Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }).then(
      ({ coords }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ lat: coords.latitude, lng: coords.longitude });
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new LocationUnavailableError(failureOf(error)));
      },
    );
  });
}
