/** The API answered with a non-2xx status; `code` is the contract's `error.code` when the body had one. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
  ) {
    super(`API request failed with status ${status}${code ? ` (${code})` : ""}`);
    this.name = "ApiError";
  }
}

/** The request got no answer: the network failed, or the configured timeout elapsed first. */
export class NetworkError extends Error {
  constructor(
    readonly timedOut: boolean,
    readonly cause?: unknown,
  ) {
    super(timedOut ? "API request timed out" : "API request failed before a response arrived");
    this.name = "NetworkError";
  }
}

/**
 * The session this call belonged to is over: the server rejected the refresh token (`expired`),
 * or a newer sign-in or sign-out superseded the call while it was in flight (`superseded`).
 */
export class SessionExpiredError extends Error {
  constructor(readonly reason: "expired" | "superseded" = "expired") {
    super(reason === "expired" ? "Session expired" : "Superseded by a newer sign-in or sign-out");
    this.name = "SessionExpiredError";
  }
}

/**
 * The device could not delete the stored refresh token on sign-out. Memory and the Query cache
 * are cleared anyway, and `restoreSession` retries the delete before it does anything else.
 */
export class LocalCleanupError extends Error {
  constructor(readonly cause?: unknown) {
    super("The device could not forget the session; it will retry on the next start");
    this.name = "LocalCleanupError";
  }
}

/**
 * The API refused to hand out an upload URL: `403` (`upload_forbidden`, `forbidden`: this role
 * cannot upload for the purpose) or `422` (`upload_invalid`: type or size not allowed). Asking
 * again with the same file gets the same answer, so nothing retries it.
 */
export class UploadRejectedError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
  ) {
    super(`The upload was refused with status ${status}${code ? ` (${code})` : ""}`);
    this.name = "UploadRejectedError";
  }
}

/** Why a file's PUT to storage failed: refused (`status`), no answer (`network`), too slow (`timeout`). */
export type UploadFailure = "status" | "network" | "timeout";

/**
 * The storage did not take the file: it answered with a non-2xx `status`, the connection failed,
 * or the PUT outlasted `EXPO_PUBLIC_UPLOAD_TIMEOUT_MS`. Nothing about the file or its URL is kept.
 */
export class UploadFailedError extends Error {
  constructor(
    readonly reason: UploadFailure,
    readonly status?: number,
  ) {
    super(
      reason === "status"
        ? `The storage refused the file with status ${status ?? "unknown"}`
        : reason === "timeout"
          ? "The upload timed out"
          : "The upload failed before the storage answered",
    );
    this.name = "UploadFailedError";
  }
}
