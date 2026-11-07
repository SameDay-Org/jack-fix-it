import { useCameraPermissions } from "expo-camera";
import { useCallback, useEffect } from "react";
import { AppState, Linking } from "react-native";

/**
 * The camera permission, with the system settings as the way back from a refusal the system will
 * not ask about again. Expo's hook reads the permission on mount and on an explicit call only, so
 * a grant made in Settings reaches this same mounted screen through a re-read when the app comes
 * back to the foreground; the re-read never prompts. That path is Android's: iOS ends the app when
 * a privacy setting changes, and the relaunch reads the permission on mount.
 */
export function useCameraAccess() {
  const [permission, requestPermission, getPermission] = useCameraPermissions();

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void getPermission();
    });
    return () => subscription.remove();
  }, [getPermission]);

  const openSettings = useCallback(() => Linking.openSettings(), []);

  return { permission, requestPermission, openSettings };
}
