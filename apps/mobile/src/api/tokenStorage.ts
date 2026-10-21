import * as SecureStore from "expo-secure-store";

// One namespaced key. The entry stays on this device: it is not restored to another one from a
// backup, and it is readable after the first unlock so a background refresh can use it.
const REFRESH_TOKEN_KEY = "jackfixit.session.refreshToken";
const WRITE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

/** The refresh token's only home. Nothing here is logged, and no other module touches the store. */
export const refreshTokenStorage = {
  read: (): Promise<string | null> => SecureStore.getItemAsync(REFRESH_TOKEN_KEY),
  write: (token: string): Promise<void> =>
    SecureStore.setItemAsync(REFRESH_TOKEN_KEY, token, WRITE_OPTIONS),
  clear: (): Promise<void> => SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY),
};
