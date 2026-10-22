import type { ApiSchema } from "@jack/shared";

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
};

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
  const body = await readLocalFile(file.uri, signal);
  // The size the URL is signed for is the size of the bytes about to be sent, by construction.
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

/** The file's bytes, read through the same native layer as any request; nothing leaves the device. */
async function readLocalFile(uri: string, signal: AbortSignal | undefined): Promise<Blob> {
  if (!LOCAL_FILE.test(uri)) throw new Error("uploadMedia reads files on this device only");
  throwIfAborted(signal);
  const response = await fetch(uri, { signal });
  return response.blob();
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
 */
function putToStorage(
  ticket: UploadTicket,
  body: Blob,
  onProgress: ((fraction: number) => void) | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  throwIfAborted(signal);
  const url = storageUrl(ticket);

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const cancel = () => xhr.abort();
    const settle = (outcome: () => void) => {
      signal?.removeEventListener("abort", cancel);
      outcome();
    };

    xhr.open("PUT", url);
    // Exactly the signed headers: nothing added (no Authorization), nothing dropped.
    for (const [name, value] of Object.entries(ticket.headers)) xhr.setRequestHeader(name, value);
    xhr.timeout = uploadTimeoutFor(body.size);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress?.(event.loaded / event.total);
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
    xhr.ontimeout = () => settle(() => reject(new UploadFailedError("timeout")));
    xhr.onabort = () => settle(() => reject(abortError(signal)));

    signal?.addEventListener("abort", cancel, { once: true });
    onProgress?.(0);
    xhr.send(body);
  });
}
