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
 * Expo's token for this build's project, bounded by the request timeout. On Android it fails
 * until the build carries Firebase's config (#335): that is reported, never retried in a loop.
 */
async function fetchDeviceToken(): Promise<string> {
  const { projectId } = notificationsConfig;
  if (!projectId) throw new MissingProjectIdError();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PushTokenTimeoutError()), apiConfig.timeoutMs);
  });
  try {
    const token = await Promise.race([Notifications.getExpoPushTokenAsync({ projectId }), timeout]);
    return token.data;
  } finally {
    clearTimeout(timer);
  }
}

async function register(startedIn: number): Promise<void> {
  const platform = devicePlatform();
  if (!platform || !isCurrentGeneration(startedIn)) return;
  if ((await refreshPermission()) !== "granted") return;
  await ensureNotificationChannel();
  const token = await fetchDeviceToken();
  if (!isCurrentGeneration(startedIn)) return;
  const previous = deviceToken;
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
 * rejects; a failure is logged by its class and the next trigger tries again.
 */
export function syncPushToken(): Promise<void> {
  armRemoval();
  const startedIn = sessionGeneration();
  return serialized(() => register(startedIn)).catch((error: unknown) =>
    reportFailure("Push token registration failed", error),
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
    const token = deviceToken;
    if (!token || !isCurrentGeneration(startedIn)) return;
    await apiDelete(
      "/v1/devices",
      { expo_push_token: token },
      { auth: true, generation: startedIn },
    );
  }).catch((error: unknown) => reportFailure("Push token removal failed", error));
}

// Armed by the first registration: until then the device holds no token to remove. Stays armed
// for every later logout, since the token outlives the session.
let disarm: (() => void) | null = null;

function armRemoval(): void {
  disarm ??= beforeSignOut(removePushToken, { timeoutMs: notificationsConfig.removalTimeoutMs });
}

/** Forgets the device token, the queue and the logout hook. Tests only. */
export function resetPushTokenForTests(): void {
  deviceToken = null;
  queue = Promise.resolve();
  disarm?.();
  disarm = null;
}
