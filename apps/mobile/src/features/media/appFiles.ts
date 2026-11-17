import { File, Paths } from "expo-file-system";

/**
 * Deletes a file the app made for a photo (the picker's copy, the compressed JPEG) once nothing
 * needs it. Callers pass only files they recorded as their own when they made them; as a second
 * guard, nothing outside the app's cache is touched, so a picture in the user's library never is.
 * A file already gone, or one the system will not delete, is left to it: this never throws.
 */
export function deleteAppFile(uri: string): void {
  try {
    if (!uri.startsWith(Paths.cache.uri)) return;
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    // Already gone, or the system's to clear with the rest of the cache.
  }
}
