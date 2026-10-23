import type { ApiSchema } from "@jack/shared";
import { Platform } from "react-native";

import { apiPost } from "./client";
import { apiConfig } from "./config";
import { ApiError, UploadFailedError, UploadRejectedError } from "./errors";
import { abortError, throwIfAborted } from "./http";

export type UploadPurpose = ApiSchema<"UploadPurpose">;
type UploadTicket = ApiSchema<"UploadResponse">;

export type UploadFile = {
  /** A file on this device (`file://` or `content://`), as the picker or the compressor left it. */
  uri: string;
  /** What the bytes are, e.g. `image/jpeg`; it is signed into the URL with the size. */
  contentType: string;
  /**
   * The file's exact size in bytes, when already known (a picked video). The file itself is then
   * the PUT's body and never passes through JavaScript: Android streams it from disk, while iOS
   * (React Native's networking) reads it into native memory first. Without a size the bytes are
   * read once as a native Blob to measure them (fine for a compressed photo). A wrong size is
   * refused by the storage, since the size is signed.
   */
  sizeBytes?: number;
};

/** What the PUT sends: a native Blob already read, or the file itself (`{ uri }`). */
type UploadBody = { send: Blob | { uri: string }; size: number };

export type UploadMediaOptions = {
  purpose: UploadPurpose;
  file: UploadFile;
  /** The share of the file's bytes the storage has taken, from 0 to 1; it starts over on a retry. */
  onProgress?: (fraction: number) => void;
  /** Cancels whichever step is running: the URL request or the PUT. */
  signal?: AbortSignal;
};

// 403 upload_forbidden / forbidden, 422 upload_invalid: the same file would get the same answer.
const REJECTED_STATUSES: ReadonlySet<number> = new Set([403, 422]);
const LOCAL_FILE = /^(file|content):/;
// React Native 0.88's Android ProgressRequestBody counts every byte twice: FilterOutputStream's
// array write loops into the overridden single-byte write, which counts too, and then the array
// write adds the whole count again. Its `loaded` reaches `total` halfway through. The tripwire
// test in upload.test.ts reads that source and fails once React Native stops double counting.
const ANDROID_PROGRESS_OVERCOUNT = 2;

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
  const body = await uploadBody(file, signal);
  // The size the URL is signed for is the size of the bytes about to be sent.
  const requestTicket = () => createUpload(purpose, file.contentType, body.size, signal);

  let ticket = await requestTicket();
  try {
    await putToStorage(ticket, body, onProgress, signal);
  } catch (error) {
    if (!(error instanceof UploadFailedError) || error.reason !== "network") throw error;
    throwIfAborted(signal);
    if (hasExpired(ticket)) ticket = await requestTicket();
    await putToStorage(ticket, body, onProgress, signal);
  }
  return { key: ticket.key };
}

async function uploadBody(file: UploadFile, signal: AbortSignal | undefined): Promise<UploadBody> {
  if (!LOCAL_FILE.test(file.uri)) throw new Error("uploadMedia reads files on this device only");
  throwIfAborted(signal);
  // A size only counts if it is a real byte count: callers can pass on a picker's null.
  if (typeof file.sizeBytes === "number" && file.sizeBytes > 0) {
    return { send: { uri: file.uri }, size: file.sizeBytes };
  }
  const blob = await readLocalFile(file.uri, signal);
  return { send: blob, size: blob.size };
}

/**
 * The file's bytes as a native Blob, read with XMLHttpRequest (`responseType: "blob"`): the bytes
 * stay in the native blob store from the read to the PUT. `fetch(uri).blob()` would copy them
 * through base64 into JavaScript, which a 100 MB video cannot afford. Nothing leaves the device.
 */
function readLocalFile(uri: string, signal: AbortSignal | undefined): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const cancel = () => xhr.abort();
    const settle = (outcome: () => void) => {
      signal?.removeEventListener("abort", cancel);
      outcome();
    };

    xhr.open("GET", uri);
    xhr.responseType = "blob";
    xhr.onload = () =>
      settle(() => {
        const blob = xhr.response as Blob | null;
        if (blob && blob.size > 0) resolve(blob);
        else reject(new Error("The file could not be read"));
      });
    xhr.onerror = () => settle(() => reject(new Error("The file could not be read")));
    xhr.onabort = () => settle(() => reject(abortError(signal)));

    signal?.addEventListener("abort", cancel, { once: true });
    xhr.send();
  });
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

/**
 * One PUT of `body` to the ticket's URL with exactly the ticket's headers. XMLHttpRequest rather
 * than fetch, for upload progress. Resolves on a 2xx; rejects with `UploadFailedError` or, when
 * the caller cancels, with the signal's abort.
 *
 * The deadline lives in JavaScript only. A native XHR timeout would mean different things on each
 * platform: Android applies it as OkHttp's call timeout and reports it as a network failure (which
 * would then be retried), and on iOS a `{ uri }` body is built before the request exists, so a
 * failure there is only logged natively and no timeout would ever start. The watchdog aborts the
 * PUT at the deadline and reports a timeout, which is not retried.
 */
function putToStorage(
  ticket: UploadTicket,
  body: UploadBody,
  onProgress: ((fraction: number) => void) | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  throwIfAborted(signal);
  const url = storageUrl(ticket);

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const timeoutMs = uploadTimeoutFor(body.size);
    let timedOut = false;
    const watchdog = setTimeout(() => {
      timedOut = true;
      xhr.abort();
    }, timeoutMs);
    const cancel = () => xhr.abort();
    const settle = (outcome: () => void) => {
      clearTimeout(watchdog);
      signal?.removeEventListener("abort", cancel);
      outcome();
    };

    xhr.open("PUT", url);
    // Exactly the signed headers: nothing added (no Authorization), nothing dropped.
    for (const [name, value] of Object.entries(ticket.headers)) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable || event.total <= 0) return;
      const counted = Platform.OS === "android" ? ANDROID_PROGRESS_OVERCOUNT : 1;
      onProgress?.(Math.min(1, event.loaded / (event.total * counted)));
    };
    xhr.onload = () =>
      settle(() => {
        if (xhr.status < 200 || xhr.status >= 300) {
          reject(new UploadFailedError("status", xhr.status));
          return;
        }
        onProgress?.(1);
        resolve();
      });
    xhr.onerror = () => settle(() => reject(new UploadFailedError("network")));
    xhr.onabort = () =>
      settle(() => reject(timedOut ? new UploadFailedError("timeout") : abortError(signal)));

    signal?.addEventListener("abort", cancel, { once: true });
    onProgress?.(0);
    // React Native's XHR also takes `{ uri }`: the native side sends the file itself as the body.
    xhr.send(body.send as unknown as XMLHttpRequestBodyInit);
  });
}
