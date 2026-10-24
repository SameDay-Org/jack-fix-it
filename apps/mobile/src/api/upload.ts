import type { ApiSchema } from "@jack/shared";
import { File, Paths, UploadType } from "expo-file-system";

import { apiPost } from "./client";
import { apiConfig } from "./config";
import { ApiError, UploadFailedError, UploadRejectedError } from "./errors";
import { abortError, throwIfAborted } from "./http";
import { createNativeUploadTask } from "./nativeUploadTask";

export type UploadPurpose = ApiSchema<"UploadPurpose">;
type UploadTicket = ApiSchema<"UploadResponse">;

export type UploadFile = {
  /** A file on this device (`file://` or `content://`), as the picker or the compressor left it. */
  uri: string;
  /** What the bytes are, e.g. `image/jpeg`; it is signed into the URL with the size. */
  contentType: string;
};

export type UploadMediaOptions = {
  purpose: UploadPurpose;
  file: UploadFile;
  /** The share of the file's bytes the storage has taken, from 0 to 1; it starts over on a retry. */
  onProgress?: (fraction: number) => void;
  /** Cancels whichever step is running: the URL request or the PUT. */
  signal?: AbortSignal;
};

type Stop = "abort" | "timeout";

// 403 upload_forbidden / forbidden, 422 upload_invalid: the same file would get the same answer.
const REJECTED_STATUSES: ReadonlySet<number> = new Set([403, 422]);
const LOCAL_FILE = /^(file|content):/;
// Never created: reading it fails at once, which is all `nativeQueueBarrier` needs.
const BARRIER_FILE = "jack-upload-barrier.missing";

/**
 * The size of a file on this device, in bytes, from its metadata, without reading it into
 * JavaScript. (Only an Android `content://` file whose provider gives no size is measured by
 * reading it natively; the picker and the compressor hand over `file://` copies.) `null` when the
 * file is missing, empty or cannot be inspected.
 */
export function localFileSize(uri: string): number | null {
  try {
    const file = new File(uri);
    if (!file.exists) return null;
    const { size } = file;
    return Number.isSafeInteger(size) && size > 0 ? size : null;
  } catch {
    return null;
  }
}

/**
 * Uploads one file for `purpose` and returns its storage key, which the feature then attaches.
 *
 * The API signs a PUT for the file's exact type and size (`POST /v1/uploads`); the bytes go
 * straight to storage at that URL with exactly the returned headers. The storage is another host,
 * so the PUT never carries the session's token, and it only ever goes to the URL the API just
 * returned. A PUT that gets no answer is tried once more, with a fresh URL if the first one has
 * expired; a refusal is final. Nothing about the file, the key or the URL is logged.
 *
 * Errors: `UploadRejectedError` (the API refused the type, size or purpose), `UploadFailedError`
 * (the storage refused, the connection failed twice, or a PUT outlasted the upload timeout), the
 * API layer's own `NetworkError` and `SessionExpiredError`, or the signal's abort.
 */
export async function uploadMedia({
  purpose,
  file,
  onProgress,
  signal,
}: UploadMediaOptions): Promise<{ key: string }> {
  if (!LOCAL_FILE.test(file.uri)) throw new Error("uploadMedia reads files on this device only");
  throwIfAborted(signal);
  // The URL is signed for the size of the file the PUT sends, taken from its metadata.
  const size = localFileSize(file.uri);
  if (size === null) throw new Error("The file could not be read");
  const requestTicket = () => createUpload(purpose, file.contentType, size, signal);

  let ticket = await requestTicket();
  try {
    await putToStorage(ticket, file.uri, size, onProgress, signal);
  } catch (error) {
    if (!(error instanceof UploadFailedError) || error.reason !== "network") throw error;
    throwIfAborted(signal);
    if (hasExpired(ticket)) ticket = await requestTicket();
    await putToStorage(ticket, file.uri, size, onProgress, signal);
  }
  return { key: ticket.key };
}

async function createUpload(
  purpose: UploadPurpose,
  contentType: string,
  sizeBytes: number,
  signal: AbortSignal | undefined,
): Promise<UploadTicket> {
  try {
    return await apiPost(
      "/v1/uploads",
      { purpose, content_type: contentType, size_bytes: sizeBytes },
      { auth: true, signal },
    );
  } catch (error) {
    if (error instanceof ApiError && REJECTED_STATUSES.has(error.status)) {
      throw new UploadRejectedError(error.status, error.code);
    }
    throw error;
  }
}

const hasExpired = (ticket: UploadTicket): boolean => Date.now() >= Date.parse(ticket.expires_at);

const MS_PER_SECOND = 1000;

/** The PUT's timeout: the fixed part, plus the time to send `bytes` at the slowest uplink waited for. */
const uploadTimeoutFor = (bytes: number): number =>
  apiConfig.uploadTimeoutMs +
  Math.ceil((bytes / apiConfig.uploadMinBytesPerSecond) * MS_PER_SECOND);

/** The URL the API returned, refused if it would send the file in the clear outside development. */
function storageUrl(ticket: UploadTicket): string {
  const { protocol } = new URL(ticket.upload_url);
  if (protocol !== "https:" && !(__DEV__ && protocol === "http:")) {
    throw new Error("The upload URL must use https:// outside development");
  }
  return ticket.upload_url;
}

const stopError = (stop: Stop, signal: AbortSignal | undefined): unknown =>
  stop === "timeout" ? new UploadFailedError("timeout") : abortError(signal);

/**
 * Settles once every Expo native call made before it has had its turn. Expo modules start async
 * functions in call order on one native queue (`expo.modules.AsyncFunctionQueue`: a serial queue
 * on iOS, one thread on Android, where a coroutine runs until its first suspension), while the
 * upload task's `cancel()` runs at once on the JavaScript thread. A barrier before a `start`
 * empties the queue, so the `start` is picked up at once; a barrier behind it is the start's
 * acknowledgement: by then the native request exists. A tripwire test in upload.test.ts reads
 * those native sources.
 */
async function nativeQueueBarrier(): Promise<void> {
  try {
    await new File(Paths.cache, BARRIER_FILE).bytes();
  } catch {
    // The file never exists: this failure is the expected answer.
  }
}

/**
 * One PUT of the file at `uri` to the ticket's URL with exactly the ticket's headers, through
 * expo-file-system's native upload task: the native side streams the file from disk on both
 * platforms, reports the bytes really sent, and its cancel stops the request. Resolves on a 2xx;
 * rejects with `UploadFailedError` or, when the caller cancels, with the signal's abort.
 *
 * Nothing is sent for an upload already cancelled or out of time: the native queue is emptied
 * first (`nativeQueueBarrier`), then the signal and the deadline are checked and the task starts
 * in the same JavaScript tick. A stop after that (the caller's abort or the deadline) cancels the
 * native task at once, wherever its start is. The native start clears its cancelled flag, so a
 * cancel that reached it while the start still waited is lost; the start's acknowledgement (a
 * barrier behind it) therefore cancels again whenever a stop is recorded.
 *
 * The client cannot do more than that: once the OS networking stack has the request, a small body
 * can be sent in full before a cancel reaches it, and the storage then keeps it. The app never
 * attaches that key; deleting uploads that are never attached is the server's job (#191).
 *
 * The promise settles only once the native task has settled, so the caller's queue never moves on
 * while bytes may still go out, and a recorded stop wins over whatever the native task reported,
 * a 2xx included. The deadline lives in JavaScript, the same on both platforms: the watchdog
 * cancels the PUT and reports a timeout, which is not retried.
 */
async function putToStorage(
  ticket: UploadTicket,
  uri: string,
  size: number,
  onProgress: ((fraction: number) => void) | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  const url = storageUrl(ticket);
  const task = createNativeUploadTask();
  let stopped: Stop | null = null;
  const progress = task.addListener("progress", ({ bytesSent, totalBytes }) => {
    if (!stopped && totalBytes > 0) onProgress?.(Math.min(1, bytesSent / totalBytes));
  });
  let startIssued = false;
  const stop = (why: Stop) => {
    if (stopped) return;
    stopped = why;
    // At once, without waiting for any acknowledgement: it stops a request that exists, and
    // marks a start still waiting as cancelled (which the start may clear: see below).
    if (startIssued) task.cancel();
  };
  const onAbort = () => stop("abort");
  const watchdog = setTimeout(() => stop("timeout"), uploadTimeoutFor(size));
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    await nativeQueueBarrier();
    // The last check before anything is sent; the listener covers every moment after it.
    if (signal?.aborted) stop("abort");
    if (stopped) throw stopError(stopped, signal);

    onProgress?.(0);
    const sending = task.start(url, new File(uri), {
      httpMethod: "PUT",
      uploadType: UploadType.BINARY_CONTENT,
      // Exactly the signed headers: nothing added (no Authorization), nothing dropped.
      headers: ticket.headers,
      // The transfer lives and ends with the app, like the deadline that guards it (iOS only).
      sessionType: "foreground",
    }); // queued on the native queue by this call
    startIssued = true;
    void nativeQueueBarrier().then(() => {
      // The start has run and cleared its cancelled flag: cancel again if a stop came before.
      if (stopped) task.cancel();
    });

    let status: number | null = null;
    try {
      ({ status } = await sending);
    } catch {
      // Handled below: a stop explains the failure, otherwise it is the network's.
    }
    // The native task has settled. A recorded stop wins, whatever it reported.
    if (stopped) throw stopError(stopped, signal);
    if (status === null) throw new UploadFailedError("network");
    if (status < 200 || status >= 300) throw new UploadFailedError("status", status);
    onProgress?.(1);
  } finally {
    clearTimeout(watchdog);
    signal?.removeEventListener("abort", onAbort);
    progress.remove();
    task.release();
  }
}
