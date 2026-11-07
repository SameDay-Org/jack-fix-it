import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

import {
  apiConfig,
  apiDelete,
  apiPut,
  beforeSignOut,
  isCurrentGeneration,
  sessionGeneration,
} from "@/api";

import { notificationsConfig } from "./config";
import { ensureNotificationChannel, refreshPermission } from "./permission";
import { reportFailure } from "./report";

/** The token's fetch outlived the request timeout (Expo's service did not answer). */
class PushTokenTimeoutError extends Error {
  override name = "PushTokenTimeoutError";
}

/** The build carries no EAS project id, so Expo cannot issue a token. */
class MissingProjectIdError extends Error {
  override name = "MissingProjectIdError";
}

// This device's Expo push token, once fetched. It belongs to the device, not to an account, so it
// outlives a sign-out: the next account registers the same token, which moves it on the server.
let deviceToken: string | null = null;

// Registration and removal run one at a time, in the order they were asked for: a removal at
// logout waits for a registration still in flight, so the server never sees the account's PUT
// land after its DELETE.
let queue: Promise<unknown> = Promise.resolve();

function serialized(operation: () => Promise<void>): Promise<void> {
  const next = queue.then(operation, operation);
  queue = next.catch(() => undefined);
  return next;
}

function devicePlatform(): "ios" | "android" | null {
  return Platform.OS === "ios" || Platform.OS === "android" ? Platform.OS : null;
}

/**
 * `work` bounded by the request timeout, so a native call that never settles cannot hold the
 * queue (and every later registration and removal) forever.
 */
async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PushTokenTimeoutError()), apiConfig.timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Expo's token for this build's project, remembered for the process. On Android it fails until
 * the build carries Firebase's config (#335): that is reported, never retried in a loop.
 */
async function fetchDeviceToken(): Promise<string> {
  const { projectId } = notificationsConfig;
  if (!projectId) throw new MissingProjectIdError();
  const token = await bounded(Notifications.getExpoPushTokenAsync({ projectId }));
  return token.data;
}

async function register(startedIn: number): Promise<void> {
  const platform = devicePlatform();
  if (!platform || !isCurrentGeneration(startedIn)) return;
  if ((await bounded(refreshPermission())) !== "granted") return;
  await bounded(ensureNotificationChannel());
  const previous = deviceToken;
  let token: string;
  try {
    token = await fetchDeviceToken();
  } catch (error) {
    // The token this process already knows still belongs on this account: registering it moves
    // it off a previous account whose removal failed.
    if (previous === null) throw error;
    reportFailure("Push token refresh failed", error);
    token = previous;
  }
  if (!isCurrentGeneration(startedIn)) return;
  deviceToken = token;
  // A rotated token: the old one comes off the account first (best effort; the server also drops
  // a token Expo reports as gone).
  if (previous && previous !== token) {
    await apiDelete(
      "/v1/devices",
      { expo_push_token: previous },
      { auth: true, generation: startedIn },
    ).catch((error: unknown) => reportFailure("Old push token removal failed", error));
  }
  await apiPut(
    "/v1/devices",
    { expo_push_token: token, platform },
    { auth: true, generation: startedIn },
  );
}

/**
 * Registers this device's push token for the signed-in account, when notifications are allowed:
 * at each sign-in and app start, when the permission turns on, and when the token changes. Pinned
 * to the session it starts in: after a sign-out or another sign-in nothing is sent for it. Never
 * rejects; resolves to false after a failure (logged by its class), for the caller to try again.
 */
export function syncPushToken(): Promise<boolean> {
  armPushTokenRemoval();
  const startedIn = sessionGeneration();
  return serialized(() => register(startedIn)).then(
    () => true,
    (error: unknown) => {
      reportFailure("Push token registration failed", error);
      return false;
    },
  );
}

/**
 * Takes this device's token off the signed-in account, after any registration still queued.
 * Runs at logout before the session is cleared (`beforeSignOut`, bounded). If it cannot reach the
 * server, the token stays on that account until the next sign-in on this device moves it.
 */
export function removePushToken(): Promise<void> {
  const startedIn = sessionGeneration();
  return serialized(async () => {
    if (!isCurrentGeneration(startedIn)) return;
    // A token an earlier launch registered is still on the server when this one has not fetched
    // it yet (a logout right after start, notifications turned off meanwhile): ask for it. The
    // fetch needs no permission; the logout's own bound limits the wait.
    const token = deviceToken ?? (await fetchDeviceToken().catch(() => null));
    if (!token || !isCurrentGeneration(startedIn)) return;
    deviceToken = token;
    await apiDelete(
      "/v1/devices",
      { expo_push_token: token },
      { auth: true, generation: startedIn },
    );
  }).catch((error: unknown) => reportFailure("Push token removal failed", error));
}

// Armed once the signed-in app is up (`usePushRegistration`) and by every registration; stays
// armed for every later logout, since the token outlives the session.
let disarm: (() => void) | null = null;

/** Makes every logout take this device's token off the account first. Idempotent. */
export function armPushTokenRemoval(): void {
  disarm ??= beforeSignOut(removePushToken, { timeoutMs: notificationsConfig.removalTimeoutMs });
}

/** Forgets the device token, the queue and the logout hook. Tests only. */
export function resetPushTokenForTests(): void {
  deviceToken = null;
  queue = Promise.resolve();
  disarm?.();
  disarm = null;
}
