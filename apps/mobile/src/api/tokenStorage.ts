import * as SecureStore from "expo-secure-store";

// Namespaced keys. The entries stay on this device: they are not restored to another one from a
// backup, and they are readable after the first unlock so a background refresh can use them.
const REFRESH_TOKEN_KEY = "jackfixit.session.refreshToken";
// The id of the account whose sign-up flow this device has not finished (#292): next to the token
// it belongs with, in the one store the app keeps between launches.
const ONBOARDING_USER_KEY = "jackfixit.session.onboardingUserId";
// The person closed the notifications pre-prompt on this device (#334). Not account data: it
// stays across sign-outs, like the permission it is about.
const NOTIFICATIONS_PROMPT_KEY = "jackfixit.notifications.promptDismissed";
const DISMISSED = "1";
// The push token this device last sent the API, and whether an account may still hold it after a
// removal that never completed (#334). The device's, not an account's: it stays across sign-outs.
const PUSH_TOKEN_KEY = "jackfixit.notifications.pushToken";
const WRITE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

// Every operation runs in order, so a write that is still pending when a sign-out deletes the
// entry cannot land after the delete, and a guarded write decides at the moment it runs. The
// onboarding marker shares the queue, so a read of it queued ahead of the token's resolves first.
let queue: Promise<unknown> = Promise.resolve();

function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const next = queue.then(operation, operation);
  queue = next.catch(() => undefined);
  return next;
}

/** What `take` removed: the token for a best-effort server revoke, and whether the delete worked. */
export type TakenToken = { token: string | null; deleted: boolean };

/** The refresh token's only home. Nothing here is logged, and no other module touches the store. */
export const refreshTokenStorage = {
  read: (): Promise<string | null> => serialized(() => SecureStore.getItemAsync(REFRESH_TOKEN_KEY)),

  /** Writes when `stillWanted()` holds as the write runs; resolves to whether it wrote. */
  write: (token: string, stillWanted: () => boolean = () => true): Promise<boolean> =>
    serialized(async () => {
      if (!stillWanted()) return false;
      await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, token, WRITE_OPTIONS);
      return true;
    }),

  clear: (): Promise<void> => serialized(() => SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY)),

  /**
   * Reads the entry and deletes it in one queued step, so nothing reads it in between. Neither
   * failure throws: the token still comes back for the revoke, and `deleted` says what happened.
   */
  take: (): Promise<TakenToken> =>
    serialized(async () => {
      const token = await SecureStore.getItemAsync(REFRESH_TOKEN_KEY).catch(() => null);
      const deleted = await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY).then(
        () => true,
        () => false,
      );
      return { token, deleted };
    }),
};

/**
 * The account still in its sign-up flow on this device, by id. Read with the token on restore;
 * written with a sign-up's tokens; cleared when the flow ends or the session does. Nothing here is
 * logged. Neither a failed read nor a failed delete throws: a marker that cannot be read is no
 * marker, and one that cannot be deleted is cleared again on the next restore of a finished flow.
 */
export const onboardingMarkerStorage = {
  read: (): Promise<string | null> =>
    serialized(() => SecureStore.getItemAsync(ONBOARDING_USER_KEY).catch(() => null)),

  /** Writes when `stillWanted()` holds as the write runs; resolves to whether it wrote. */
  write: (userId: string, stillWanted: () => boolean = () => true): Promise<boolean> =>
    serialized(async () => {
      if (!stillWanted()) return false;
      await SecureStore.setItemAsync(ONBOARDING_USER_KEY, userId, WRITE_OPTIONS);
      return true;
    }),

  clear: (): Promise<void> =>
    serialized(() => SecureStore.deleteItemAsync(ONBOARDING_USER_KEY).catch(() => undefined)),
};

/**
 * Whether the notifications pre-prompt was closed on this device. A failed read counts as not
 * closed (the card can be closed again); a failed write rejects, for the caller to log.
 */
export const notificationsPromptStorage = {
  readDismissed: (): Promise<boolean> =>
    serialized(() =>
      SecureStore.getItemAsync(NOTIFICATIONS_PROMPT_KEY).then(
        (value) => value === DISMISSED,
        () => false,
      ),
    ),

  writeDismissed: (): Promise<void> =>
    serialized(() => SecureStore.setItemAsync(NOTIFICATIONS_PROMPT_KEY, DISMISSED, WRITE_OPTIONS)),
};

/**
 * What the device records about its push token (`features/notifications/pushToken.ts` owns the
 * rules):
 * - `owed`: an account may hold `token`; its removal is not confirmed.
 * - `unanswered`: a PUT of `token` left this device and no answer to it is recorded. It may still
 *   land, so an acknowledged PUT after it does not prove who holds the token.
 * - `retired`: tokens Expo replaced, each until the server confirms its removal.
 * A flag or a list that holds nothing is not written.
 */
export type StoredPushToken = {
  token: string;
  owed: boolean;
  unanswered?: true;
  retired?: string[];
};

function parsePushToken(value: string | null): StoredPushToken | null {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { token, owed, unanswered, retired } = parsed as Record<string, unknown>;
    if (typeof token !== "string" || token === "" || typeof owed !== "boolean") return null;
    const tokens = Array.isArray(retired)
      ? retired.filter((item): item is string => typeof item === "string" && item !== "")
      : [];
    return {
      token,
      owed,
      ...(unanswered === true ? { unanswered: true as const } : {}),
      ...(tokens.length > 0 ? { retired: tokens } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * The push token's state, in one entry so a token and its `owed` flag are written together.
 * Nothing here is logged. An entry that cannot be parsed counts as no token (the app asks Expo
 * again). A read that fails rejects: the entry may be there, with an account still holding its
 * token, so the caller must not take it for no token. A failed write rejects too: nothing was
 * recorded.
 */
export const pushTokenStorage = {
  read: (): Promise<StoredPushToken | null> =>
    serialized(() => SecureStore.getItemAsync(PUSH_TOKEN_KEY).then(parsePushToken)),

  write: (value: StoredPushToken): Promise<void> =>
    serialized(() =>
      SecureStore.setItemAsync(
        PUSH_TOKEN_KEY,
        JSON.stringify({
          token: value.token,
          owed: value.owed,
          ...(value.unanswered ? { unanswered: true } : {}),
          ...(value.retired?.length ? { retired: value.retired } : {}),
        }),
        WRITE_OPTIONS,
      ),
    ),
};
