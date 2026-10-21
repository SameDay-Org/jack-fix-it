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

/** The refresh token was rejected: the session is over and the user has to sign in again. */
export class SessionExpiredError extends Error {
  constructor() {
    super("Session expired");
    this.name = "SessionExpiredError";
  }
}
