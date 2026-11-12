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

// What this device last sent the API, kept on the device (`pushTokenStorage`) so it outlives the
// process as well as the session. Everything an account may hold is written there before the
// request that can put it on that account goes out (a write that fails stops the request), and
// leaves the record only once the server confirms a removal:
// - `owed`: an account may hold the token. True before any PUT, false only after a confirmed
//   DELETE.
// - `unanswered`: a PUT of the token went out and no answer to it is recorded (cut off by a
//   logout, timed out, offline, the process killed). The server may still apply it, after a later
//   account's PUT too. So until a removal is confirmed no acknowledged PUT proves who holds the
//   token: it is registered again right before it is removed, never removed on that proof alone.
// - `retired`: the tokens Expo replaced. Each stays until the server confirms its own removal.
// So whatever ends a session (a logout cut off by its bound, an expired refresh token, the process
// killed at any step), an account may still hold a token only while the record says so, and the
// next sign-in on this device moves it off that account. Here: what the last read or write that
// succeeded established. `undefined` until then, and again after a write that failed (it may have
// landed or not), so the device is read again.
let known: StoredPushToken | null | undefined;

// The token this process registered with a confirmed PUT, and the session it did it in. While that
// session lasts and no PUT of the token is unanswered, its account holds the token, so removing it
// there needs no move first.
let registered: { token: string; generation: number } | null = null;

// Registration and removal run one at a time, in the order they were asked for: a removal at
// logout waits for a registration still in flight, so the server never sees the account's PUT
// land after its DELETE.
let queue: Promise<unknown> = Promise.resolve();

function serialized<T>(operation: () => Promise<T>): Promise<T> {
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

/** A record as it is written: a flag or a list that holds nothing is left out. */
function recordOf(
  token: string,
  owed: boolean,
  unanswered: boolean,
  retired: readonly string[] = [],
): StoredPushToken {
  return {
    token,
    owed,
    ...(unanswered ? { unanswered: true as const } : {}),
    ...(retired.length > 0 ? { retired: [...retired] } : {}),
  };
}

function sameRecord(a: StoredPushToken, b: StoredPushToken): boolean {
  const [left, right] = [a.retired ?? [], b.retired ?? []];
  return (
    a.token === b.token &&
    a.owed === b.owed &&
    (a.unanswered ?? false) === (b.unanswered ?? false) &&
    left.length === right.length &&
    left.every((token, index) => token === right[index])
  );
}

/**
 * Records `next` on the device (awaited: a kill right after keeps it), then for this process.
 * Rejects when the write fails: nothing is known to be recorded, so the request that relies on
 * the record must not go out. Writes nothing when the device already holds exactly `next` (`known`
 * is only ever what a read or a write that succeeded established, and nothing else writes it).
 */
async function remember(next: StoredPushToken): Promise<void> {
  if (known && sameRecord(known, next)) return;
  try {
    await pushTokenStorage.write(next);
  } catch (error) {
    known = undefined;
    throw new PushTokenStateError(error);
  }
  known = next;
}

const pinnedTo = (startedIn: number) => ({ auth: true, generation: startedIn }) as const;

/**
 * Registers `token` for the session's account. Recorded first, on the device, as owed and
 * unanswered: from that write on this account may hold the token, whatever becomes of the request
 * (a mark that cannot be written stops it). The server's answer clears `unanswered`, unless an
 * earlier PUT of the token (`earlier`) is still without its own: this answer says nothing about
 * when that one lands.
 */
async function put(
  token: string,
  platform: DevicePlatform,
  startedIn: number,
  earlier: boolean,
): Promise<void> {
  await remember(recordOf(token, true, true, known?.retired));
  await apiPut("/v1/devices", { expo_push_token: token, platform }, pinnedTo(startedIn));
  registered = { token, generation: startedIn };
  if (!earlier) await remember(recordOf(token, true, false, known?.retired));
}

/**
 * Takes `token` off the session's account; only the server's confirmation clears its marks. The
 * caller has made sure the account holds it (`moveOwedToken`): the API answers a DELETE of a
 * token its caller does not hold the same way, and that answer confirms nothing.
 */
async function unregister(token: string, startedIn: number): Promise<void> {
  await apiDelete("/v1/devices", { expo_push_token: token }, pinnedTo(startedIn));
  registered = null;
  await remember(recordOf(token, false, false, known?.retired));
}

/**
 * This session's own acknowledged PUT put the record's token on its account, and no PUT of it is
 * unanswered: nothing that left this device can still move it elsewhere.
 */
const heldHere = (last: StoredPushToken, startedIn: number): boolean =>
  !last.unanswered && registered?.token === last.token && registered.generation === startedIn;

/**
 * A token the device's record (`last`) marks owed may be held by an account that signed out (its
 * removal never completed), so it moves to the signed-in account first, whatever Expo answers
 * next: the API's upsert moves a token to whoever registers it, and its DELETE only takes a token
 * off its caller. Skipped only when this session is known to hold it (`heldHere`). The mark stays:
 * this account holds it now. Resolves to the token moved, or null.
 */
async function moveOwedToken(
  last: StoredPushToken | null,
  startedIn: number,
  platform: DevicePlatform,
): Promise<string | null> {
  if (!last?.owed || !isCurrentGeneration(startedIn)) return null;
  if (heldHere(last, startedIn)) return null;
  await put(last.token, platform, startedIn, last.unanswered === true);
  return last.token;
}

/**
 * Takes the retired tokens off whichever account holds them, oldest first: each moves to the
 * session's account, then comes off it, and leaves the record once the server confirms.
 * `held`: the one this session is known to hold, which needs no move. Rejects at the first
 * failure: that token and the ones after it stay recorded, for the next try.
 */
async function removeRetired(
  startedIn: number,
  platform: DevicePlatform,
  held: string | null,
): Promise<void> {
  for (const token of known?.retired ?? []) {
    if (!isCurrentGeneration(startedIn)) return;
    if (token !== held) {
      await apiPut("/v1/devices", { expo_push_token: token, platform }, pinnedTo(startedIn));
    }
    await apiDelete("/v1/devices", { expo_push_token: token }, pinnedTo(startedIn));
    const now = known;
    if (!now) return;
    await remember(
      recordOf(
        now.token,
        now.owed,
        now.unanswered === true,
        (now.retired ?? []).filter((item) => item !== token),
      ),
    );
  }
}

/** Resolves to false when the token is registered but an old one's removal is still owed. */
async function register(startedIn: number): Promise<void | false> {
  const platform = devicePlatform();
  if (!platform || !isCurrentGeneration(startedIn)) return;
  if ((await bounded(refreshPermission())) !== "granted") return;
  await bounded(ensureNotificationChannel());
  // A record that cannot be read stops the registration here (the caller tries again): the token
  // an earlier account may still hold is in it.
  const last = await lastSent();
  const moved = await moveOwedToken(last, startedIn, platform);
  const before = known ?? null;
  let token: string;
  try {
    token = await fetchDeviceToken();
  } catch (error) {
    // The token this device last sent still belongs on this account: registering it moves it off
    // a previous account whose removal failed, even when Expo cannot be reached now.
    if (before === null) throw error;
    reportFailure("Push token refresh failed", error);
    token = before.token;
  }
  if (!isCurrentGeneration(startedIn)) return;

  // A rotated token. One write, before anything is sent: the new token is marked as every token
  // is before its PUT, and the old one, when an account may hold it, joins the retired ones. It
  // stays there until the server confirms its removal, so neither a removal that fails now nor
  // the process dying after this write loses track of it.
  const rotated = before !== null && before.token !== token;
  let held: string | null = null;
  let earlier = before?.unanswered === true;
  if (rotated) {
    if (before.owed && heldHere(before, startedIn)) held = before.token;
    // Back to a token retired earlier: what became of its last PUT is not known.
    earlier = before.retired?.includes(token) === true;
    const retired = (before.retired ?? []).filter((old) => old !== token && old !== before.token);
    if (before.owed) retired.push(before.token);
    await remember(recordOf(token, true, true, retired));
  }
  // The old tokens come off first. One whose removal fails stays recorded and does not hold the
  // registration back: the failure is kept for the end, where it makes the caller try again.
  const cleanup: { failed: boolean; error?: unknown } = { failed: false };
  if (known?.retired) {
    try {
      await removeRetired(startedIn, platform, held);
    } catch (error) {
      if (error instanceof PushTokenStateError) throw error;
      cleanup.failed = true;
      cleanup.error = error;
    }
  }
  // The owed token just moved here is already registered.
  if (rotated || moved !== token) await put(token, platform, startedIn, earlier);
  if (cleanup.failed) {
    reportFailure("Old push token removal failed", cleanup.error);
    return false;
  }
}

/** Runs `operation` in the queue for the session current now; resolves to whether it succeeded. */
function settled(
  what: string,
  operation: (startedIn: number) => Promise<void | false>,
): Promise<boolean> {
  const startedIn = sessionGeneration();
  return serialized(() => operation(startedIn)).then(
    (result) => result !== false,
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
 * A device store that cannot be read or written is such a failure (the token is not registered),
 * and so is a replaced token whose removal did not go through (the new one is registered).
 */
export function syncPushToken(): Promise<boolean> {
  armPushTokenRemoval();
  return settled("Push token registration failed", register);
}

/**
 * For a signed-in account with notifications off: whatever the record still marks (the token an
 * account that signed out may hold, or this one did before notifications went off, and every
 * retired token) moves to this account and then comes off it too, so no account keeps this
 * device. Sends nothing when nothing is marked. Never rejects; resolves to false after a failure,
 * to try again: a record that could not be read is one (it is read again then), and so is a
 * cleared mark that could not be written.
 */
export function settleOwedPushToken(): Promise<boolean> {
  armPushTokenRemoval();
  return settled("Owed push token removal failed", async (startedIn) => {
    const platform = devicePlatform();
    if (!platform) return;
    const owed = await lastSent();
    if (!owed || (!owed.owed && !owed.retired) || !isCurrentGeneration(startedIn)) return;
    await moveOwedToken(owed, startedIn, platform);
    // Turned on meanwhile: the token stays on this account (still owed, by it now), for the
    // registration that follows; it takes the retired ones off too.
    if ((await bounded(refreshPermission())) === "granted") return;
    if (owed.owed) await unregister(owed.token, startedIn);
    await removeRetired(startedIn, platform, null);
  });
}

/**
 * Takes this device's token off the signed-in account, after any registration still queued, and
 * then the retired ones. Runs at logout before the session is cleared (`beforeSignOut`, bounded).
 * A token this account may hold is already marked on the device (written before its PUT), and
 * only the server's confirmation clears the mark: if the removal cannot reach the server, the
 * logout's bound runs out first, or the process dies at any step, the next sign-in on this device
 * (any account, after a restart too) moves the token off this account.
 */
export function removePushToken(): Promise<void> {
  const startedIn = sessionGeneration();
  return serialized(async () => {
    // Cut off (the logout's bound ran out while a registration held the queue): what the account
    // may hold is marked owed already, for the next sign-in to settle.
    if (!isCurrentGeneration(startedIn)) return;
    const read = await lastSent().then(
      (record) => ({ record, readable: true }),
      (error: unknown) => {
        reportFailure("Push token state read failed", error);
        return { record: null, readable: false };
      },
    );
    if (!read.readable) {
      // The record is there, with whatever it marks, and cannot be read now. Nothing is written
      // over it (that would drop the marks it holds), and nothing is sent that could put a token
      // on this account under it: only a DELETE, of the token this process registered or of
      // Expo's, which can take a token off this account and leave it on none. What the record
      // marks stays for the next sign-in, which reads the device again.
      const token = registered?.token ?? (await fetchDeviceToken().catch(() => null));
      if (!token || !isCurrentGeneration(startedIn)) return;
      await apiDelete("/v1/devices", { expo_push_token: token }, pinnedTo(startedIn));
      registered = null;
      return;
    }
    const last = read.record;
    // Still owed by an earlier account (notifications off since, the move failed), or a PUT of it
    // is unanswered and may have landed anywhere since: the DELETE only takes a token off its
    // caller, so the token moves here first.
    const platform = devicePlatform();
    if (platform) await moveOwedToken(last, startedIn, platform);
    // No token sent from this install yet (a logout right after the first start, notifications
    // off): ask Expo for it. The fetch needs no permission; the logout's own bound limits the wait.
    const token = last?.token ?? (await fetchDeviceToken().catch(() => null));
    if (!token || !isCurrentGeneration(startedIn)) return;
    // With no record on the device (nothing was ever sent from it) any account may hold the
    // token: it moves here first, as an owed one does. Marked owed first either way, as before
    // every PUT: when the mark cannot be written nothing is sent.
    if (!last && platform) {
      await put(token, platform, startedIn, false);
    } else if (!last?.owed) {
      await remember(recordOf(token, true, false, last?.retired));
    }
    await unregister(token, startedIn);
    if (platform) await removeRetired(startedIn, platform, null);
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
