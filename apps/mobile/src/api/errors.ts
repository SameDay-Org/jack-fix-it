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
