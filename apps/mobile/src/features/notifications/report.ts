// The error class alone: the client and its configuration stay out of what imports this.
import { SessionExpiredError } from "@/api/errors";

// A native error code is a constant like E_REGISTRATION_FAILED; anything else is not logged.
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * Logs a failed push step by the error's class (and a native error code), never its message,
 * which can carry a token or a server's text. A step the session left behind (a sign-out or
 * another sign-in) is not a failure and logs nothing.
 */
export function reportFailure(what: string, error: unknown): void {
  if (error instanceof SessionExpiredError) return;
  const name = error instanceof Error ? error.name : "unknown";
  const code = (error as { code?: unknown } | null)?.code;
  const suffix = typeof code === "string" && ERROR_CODE.test(code) ? ` (${code})` : "";
  console.warn(`${what}: ${name}${suffix}`);
}
