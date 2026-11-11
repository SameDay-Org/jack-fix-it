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
import { pushTokenStorage, type StoredPushToken } from "@/api/tokenStorage";

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

/**
 * The device's store failed to read or to record the token's state: what an account may hold is
 * then unknown, or not recorded, so nothing is sent on a guess and the caller tries again. Carries
 * the store's error code for the log, never its message (it can quote the value).
 */
class PushTokenStateError extends Error {
  override name = "PushTokenStateError";
  readonly code: unknown;

  constructor(cause: unknown) {
    super();
    this.code = (cause as { code?: unknown } | null)?.code;
  }
}

const stateFailure = (cause: unknown): never => {
  throw new PushTokenStateError(cause);
};

type DevicePlatform = "ios" | "android";

// The token this device last sent the API, kept on the device (`pushTokenStorage`) so it outlives
// the process as well as the session. `owed` is written ahead: true, on the device, before any
// request that can leave an account holding the token (a write that fails stops that request),
// false only once the server confirms its DELETE. So whatever ends a session (a logout cut off by
// its bound, an expired refresh token, the process killed at any step), an account may still hold
// the token only while it is marked owed, and the next sign-in on this device moves it off that
// account. Here: what the last read or write that succeeded established. `undefined` until then,
// and again after a write that failed (it may have landed or not), so the device is read again.
let known: StoredPushToken | null | undefined;

// The token this process registered with a confirmed PUT, and the session it did it in: while that
// session lasts its account holds the token, so removing it there needs no move first.
let registered: { token: string; generation: number } | null = null;

// Registration and removal run one at a time, in the order they were asked for: a removal at
// logout waits for a registration still in flight, so the server never sees the account's PUT
// land after its DELETE.
let queue: Promise<unknown> = Promise.resolve();

function serialized(operation: () => Promise<void>): Promise<void> {
  const next = queue.then(operation, operation);
  queue = next.catch(() => undefined);
  return next;
}

function devicePlatform(): DevicePlatform | null {
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
 * Expo's token for this build's project. On Android it fails until the build carries Firebase's
 * config (#335): that is reported, never retried in a loop.
 */
async function fetchDeviceToken(): Promise<string> {
  const { projectId } = notificationsConfig;
  if (!projectId) throw new MissingProjectIdError();
  const token = await bounded(Notifications.getExpoPushTokenAsync({ projectId }));
  return token.data;
}

/**
 * The last token sent, read from the device once per process. A read that fails rejects and is
 * not kept: the record may be there, with an account still holding its token, so it is never
 * taken for "nothing owed", and the next call reads again.
 */
async function lastSent(): Promise<StoredPushToken | null> {
  if (known === undefined) {
    const stored = await pushTokenStorage.read().catch(stateFailure);
    known ??= stored;
  }
  return known;
}

/**
 * Records `next` on the device (awaited: a kill right after keeps it), then for this process.
 * Rejects when the write fails: nothing is known to be recorded, so the request that relies on
 * the record must not go out. Writes nothing when the device already holds exactly `next` (`known`
 * is only ever what a read or a write that succeeded established, and nothing else writes it).
 */
async function remember(next: StoredPushToken): Promise<void> {
  if (known?.token === next.token && known.owed === next.owed) return;
  try {
    await pushTokenStorage.write(next);
  } catch (error) {
    known = undefined;
    throw new PushTokenStateError(error);
  }
  known = next;
}

const pinnedTo = (startedIn: number) => ({ auth: true, generation: startedIn }) as const;

/** Registers `token` for the session's account; marked owed before the call (`remember`). */
async function put(token: string, platform: DevicePlatform, startedIn: number): Promise<void> {
  await apiPut("/v1/devices", { expo_push_token: token, platform }, pinnedTo(startedIn));
  registered = { token, generation: startedIn };
}

/** Takes `token` off the session's account; only the server's confirmation clears the mark. */
async function unregister(token: string, startedIn: number): Promise<void> {
  await apiDelete("/v1/devices", { expo_push_token: token }, pinnedTo(startedIn));
  registered = null;
  await remember({ token, owed: false });
}

/**
 * A token the device's record (`last`) marks owed may be held by an account that signed out (its
 * removal never completed), so it moves to the signed-in account first, whatever Expo answers
 * next: the API's upsert moves a token to whoever registers it, and its DELETE only takes a token
 * off its caller. Skipped when this session's own PUT already put it here. The mark stays: this
 * account holds it now. Resolves to the token moved, or null.
 */
async function moveOwedToken(
  last: StoredPushToken | null,
  startedIn: number,
  platform: DevicePlatform,
): Promise<string | null> {
  if (!last?.owed || !isCurrentGeneration(startedIn)) return null;
  if (registered?.token === last.token && registered.generation === startedIn) return null;
  await put(last.token, platform, startedIn);
  return last.token;
}

async function register(startedIn: number): Promise<void> {
  const platform = devicePlatform();
  if (!platform || !isCurrentGeneration(startedIn)) return;
  if ((await bounded(refreshPermission())) !== "granted") return;
  await bounded(ensureNotificationChannel());
  // A record that cannot be read stops the registration here (the caller tries again): the token
  // an earlier account may still hold is in it.
  const last = await lastSent();
  const moved = await moveOwedToken(last, startedIn, platform);
  const previous = last?.token ?? null;
  let token: string;
  try {
    token = await fetchDeviceToken();
  } catch (error) {
    // The token this device last sent still belongs on this account: registering it moves it off
    // a previous account whose removal failed, even when Expo cannot be reached now.
    if (previous === null) throw error;
    reportFailure("Push token refresh failed", error);
    token = previous;
  }
  if (!isCurrentGeneration(startedIn)) return;
  // Owed before the PUT, on the device: from here on this account may hold the token, so a logout
  // removes it even when the PUT's answer is lost, and the next sign-in moves it if the logout
  // never lands. A mark that cannot be written stops the registration (the caller tries again):
  // a PUT without it could leave this account holding the token under a record that says nobody
  // does.
  await remember({ token, owed: true });
  // A rotated token: the old one comes off the account first (best effort; the server also drops
  // a token Expo reports as gone).
  if (previous && previous !== token) {
    await apiDelete("/v1/devices", { expo_push_token: previous }, pinnedTo(startedIn)).catch(
      (error: unknown) => reportFailure("Old push token removal failed", error),
    );
  }
  // The owed token just moved here is already registered.
  if (moved !== token) await put(token, platform, startedIn);
}

/** Runs `operation` in the queue for the session current now; resolves to whether it succeeded. */
function settled(what: string, operation: (startedIn: number) => Promise<void>): Promise<boolean> {
  const startedIn = sessionGeneration();
  return serialized(() => operation(startedIn)).then(
    () => true,
    (error: unknown) => {
      reportFailure(what, error);
      return false;
    },
  );
}

/**
 * Registers this device's push token for the signed-in account, when notifications are allowed:
 * at each sign-in and app start, when the permission turns on, and when the token changes. Pinned
 * to the session it starts in: after a sign-out or another sign-in nothing is sent for it. Never
 * rejects; resolves to false after a failure (logged by its class), for the caller to try again.
 * A device store that cannot be read or written is such a failure: the token is not registered.
 */
export function syncPushToken(): Promise<boolean> {
  armPushTokenRemoval();
  return settled("Push token registration failed", register);
}

/**
 * For a signed-in account with notifications off: a token still marked owed (an account that
 * signed out may hold it, or this one did before notifications went off) moves to this account
 * and then comes off it too, so no account keeps this device. Sends nothing when nothing is owed.
 * Never rejects; resolves to false after a failure, to try again: a record that could not be read
 * is one (it is read again then), and so is a cleared mark that could not be written.
 */
export function settleOwedPushToken(): Promise<boolean> {
  armPushTokenRemoval();
  return settled("Owed push token removal failed", async (startedIn) => {
    const platform = devicePlatform();
    if (!platform) return;
    const owed = await lastSent();
    if (!owed?.owed || !isCurrentGeneration(startedIn)) return;
    await moveOwedToken(owed, startedIn, platform);
    // Turned on meanwhile: the token stays on this account (still owed, by it now), for the
    // registration that follows.
    if ((await bounded(refreshPermission())) === "granted") return;
    await unregister(owed.token, startedIn);
  });
}

/**
 * Takes this device's token off the signed-in account, after any registration still queued.
 * Runs at logout before the session is cleared (`beforeSignOut`, bounded). A token this account
 * may hold is already marked owed on the device (written before its PUT), and only the server's
 * confirmation clears the mark: if the removal cannot reach the server, the logout's bound runs out
 * first, or the process dies at any step, the next sign-in on this device (any account, after a
 * restart too) moves the token off this account.
 */
export function removePushToken(): Promise<void> {
  const startedIn = sessionGeneration();
  return serialized(async () => {
    // Cut off (the logout's bound ran out while a registration held the queue): what the account
    // may hold is marked owed already, for the next sign-in to settle.
    if (!isCurrentGeneration(startedIn)) return;
    // A logout has no later try: a record that cannot be read now is handled as no record (below),
    // and is not kept, so the next sign-in reads the device again.
    const last = await lastSent().catch((error: unknown) => {
      reportFailure("Push token state read failed", error);
      return null;
    });
    // Still owed by an earlier account (notifications off since, the move failed): the DELETE
    // only takes a token off its caller, so the token moves here first.
    const platform = devicePlatform();
    if (platform) await moveOwedToken(last, startedIn, platform);
    // No token sent from this install yet (a logout right after the first start, notifications
    // off): ask Expo for it. The fetch needs no permission; the logout's own bound limits the wait.
    const token = last?.token ?? (await fetchDeviceToken().catch(() => null));
    if (!token || !isCurrentGeneration(startedIn)) return;
    // Marked owed first, as before every PUT: when the mark cannot be written nothing is sent.
    if (!last?.owed) await remember({ token, owed: true });
    // With no record on the device (none sent, or the store could not be read) any account may
    // hold the token: it moves here first, as an owed one does.
    if (!last && platform) await put(token, platform, startedIn);
    await unregister(token, startedIn);
  }).catch((error: unknown) => reportFailure("Push token removal failed", error));
}

// Armed once the signed-in app is up (`usePushRegistration`) and by every registration; stays
// armed for every later logout, since the token outlives the session.
let disarm: (() => void) | null = null;

/** Makes every logout take this device's token off the account first. Idempotent. */
export function armPushTokenRemoval(): void {
  disarm ??= beforeSignOut(removePushToken, { timeoutMs: notificationsConfig.removalTimeoutMs });
}

/**
 * Forgets what this process holds (the token as read, the queue, the logout hook), as a restart
 * does; the device's stored state stays. Tests only.
 */
export function resetPushTokenForTests(): void {
  known = undefined;
  registered = null;
  queue = Promise.resolve();
  disarm?.();
  disarm = null;
}
