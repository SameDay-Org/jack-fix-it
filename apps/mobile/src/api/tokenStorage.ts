import * as SecureStore from "expo-secure-store";

// One namespaced key. The entry stays on this device: it is not restored to another one from a
// backup, and it is readable after the first unlock so a background refresh can use it.
const REFRESH_TOKEN_KEY = "jackfixit.session.refreshToken";
const WRITE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

// Every operation runs in order, so a write that is still pending when a sign-out deletes the
// entry cannot land after the delete, and a guarded write decides at the moment it runs.
let queue: Promise<unknown> = Promise.resolve();

function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const next = queue.then(operation, operation);
  queue = next.catch(() => undefined);
  return next;
}

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
};
