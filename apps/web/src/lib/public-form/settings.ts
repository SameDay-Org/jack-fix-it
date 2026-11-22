import type { FormTimings } from "./form-token";

// A public form's server settings: its signing secret, the web service's key and its token's
// timings. Read on the server only.

/** The shortest secret accepted, as the API's RATE_LIMIT_KEY_SECRET. */
export const SECRET_MIN_LENGTH = 32;

/**
 * A required secret: missing or shorter than SECRET_MIN_LENGTH throws, so a form that could not
 * be sent is never served.
 */
export function requiredSecret(name: string): string {
  const value = process.env[name];
  if (!value || value.length < SECRET_MIN_LENGTH) {
    throw new Error(`${name} is not set to a secret of at least ${SECRET_MIN_LENGTH} characters`);
  }
  return value;
}

function seconds(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/**
 * How old a form's token must be to send and may be at most: `<prefix>_MIN_SECONDS` and
 * `<prefix>_MAX_AGE_SECONDS`, 3 seconds and 2 hours when unset or not a positive whole number.
 */
export function formTimings(prefix: "REQUEST_FORM" | "INTEREST_FORM"): FormTimings {
  return {
    minSeconds: seconds(`${prefix}_MIN_SECONDS`, 3),
    maxAgeSeconds: seconds(`${prefix}_MAX_AGE_SECONDS`, 7200),
  };
}
