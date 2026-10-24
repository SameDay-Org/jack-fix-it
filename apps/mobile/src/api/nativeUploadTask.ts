import { requireNativeModule } from "expo";
import type { File, UploadType } from "expo-file-system";

type NativeUploadOptions = {
  httpMethod: "PUT";
  uploadType: UploadType;
  headers: Record<string, string>;
  /** iOS only: a foreground session lives and ends with the app. */
  sessionType: "foreground";
};

/**
 * expo-file-system's native upload handle, the one its public `UploadTask` wraps (58.0.x). The
 * wrapper's `cancel()` acts only once, and the upload has to cancel a second time once the native
 * start has run (see `putToStorage`), so it drives this handle itself. A tripwire test in
 * upload.test.ts pins the wrapper's calls to it.
 */
export type NativeUploadTask = {
  /** An Expo async function: queued on the module's native queue at the moment of the call. */
  start(url: string, file: File, options: NativeUploadOptions): Promise<{ status: number }>;
  /** Synchronous: runs at once on the JavaScript thread. Safe to call any number of times. */
  cancel(): void;
  addListener(
    event: "progress",
    listener: (progress: { bytesSent: number; totalBytes: number }) => void,
  ): { remove(): void };
  release(): void;
};

type FileSystemModule = { FileSystemUploadTask: new () => NativeUploadTask };

export function createNativeUploadTask(): NativeUploadTask {
  return new (requireNativeModule<FileSystemModule>("FileSystem").FileSystemUploadTask)();
}
