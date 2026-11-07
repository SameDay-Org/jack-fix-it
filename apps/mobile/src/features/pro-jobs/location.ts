import * as Location from "expo-location";
import { useCallback, useEffect, useState } from "react";
import { AppState, Linking, Platform } from "react-native";

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
 * shows the system prompt and answers whether access was granted. `refused` is for a position
 * the system refused for want of permission: the permission is read again, and it never reads
 * as granted until the next read (back from Settings), so the sheet shows the way to Settings
 * rather than the code again. Nothing about the place is read here.
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

  const refused = useCallback(async (): Promise<void> => {
    let next: LocationAccess = "blocked";
    try {
      next = accessOf(await Location.getForegroundPermissionsAsync());
    } catch {
      // unreadable: blocked, as the refusal said
    }
    setAccess(next === "granted" ? "blocked" : next);
  }, []);

  const openSettings = useCallback(() => void Linking.openSettings(), []);

  return { access, ask, refused, openSettings };
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

// The codes expo-location 58's native errors carry (CodedException: "ERR_" and the exception's
// name): the location switched off (iOS) or the Android settings check failed, and the
// permission missing (Android) or refused (iOS).
const LOCATION_OFF = new Set([
  "ERR_LOCATION_SERVICES_DISABLED",
  "ERR_LOCATION_SETTINGS_UNSATISFIED",
]);
const NO_PERMISSION = new Set([
  "ERR_LOCATION_UNAUTHORIZED",
  "ERR_DENIED_FOREGROUND_LOCATION_PERMISSION",
]);

function failureOf(error: unknown): LocationFailure {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code !== "string") return "failed";
  if (LOCATION_OFF.has(code)) return "off";
  if (NO_PERMISSION.has(code)) return "denied";
  return "failed";
}

/**
 * The phone's location switched on, or an `off` error. On Android a switched-off location gets the
 * system's one-tap "turn on location" dialog first; declining it is `off` too. iOS has no such
 * dialog: the pro turns it on in Settings.
 */
async function ensureLocationOn(): Promise<void> {
  let on: boolean;
  try {
    on = await Location.hasServicesEnabledAsync();
  } catch {
    return; // unknown: the position request reports it if it is off
  }
  if (on) return;
  if (Platform.OS !== "android") throw new LocationUnavailableError("off");
  try {
    await Location.enableNetworkProviderAsync();
  } catch {
    throw new LocationUnavailableError("off");
  }
}

/**
 * The phone's position right now, once, from the GPS and the network together (High: a one-shot
 * fix at the door, where Balanced would wait on a network fix alone),
 * or a `LocationUnavailableError`. The location is switched on first (Android's dialog is not
 * timed); the fix itself gets `timeoutMs`, and one that comes after it is dropped. The caller
 * holds the permission already.
 */
export async function currentPosition(timeoutMs: number): Promise<CheckInPosition> {
  await ensureLocationOn();
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(new LocationUnavailableError("timeout"));
    }, timeoutMs);
    // The location is on by now: no second settings dialog under a running timer.
    Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.High,
      mayShowUserSettingsDialog: false,
    }).then(
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
