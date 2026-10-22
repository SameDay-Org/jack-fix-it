import { ApiError, NetworkError } from "@/api";

/** Catalog keys for a phone verification failure; the server's own text is never shown. */
export type PhoneFailureKey =
  | "phone.errors.invalidCode"
  | "phone.errors.numberUnavailable"
  | "phone.errors.serviceUnavailable"
  | "phone.errors.invalidNumber"
  | "auth.errors.rateLimited"
  | "auth.errors.offline"
  | "auth.errors.generic";

// Server codes from the phone contract (#26). `validation_error` only gets past the device's own
// checks when the server refuses the calling code, so it is about the number.
const BY_CODE: Readonly<Record<string, PhoneFailureKey>> = {
  invalid_code: "phone.errors.invalidCode",
  phone_unavailable: "phone.errors.numberUnavailable",
  rate_limited: "auth.errors.rateLimited",
  verification_unavailable: "phone.errors.serviceUnavailable",
  validation_error: "phone.errors.invalidNumber",
};

/** The message a send or verify failure gets, as a catalog key. */
export function describePhoneFailure(error: unknown): PhoneFailureKey {
  if (error instanceof NetworkError) return "auth.errors.offline";
  if (error instanceof ApiError && error.code !== undefined && Object.hasOwn(BY_CODE, error.code)) {
    return BY_CODE[error.code];
  }
  return "auth.errors.generic";
}
