/** How the app reaches the API, and the server rules it mirrors, read once at startup. */
export type ApiConfig = {
  readonly baseUrl: URL;
  readonly timeoutMs: number;
  /**
   * The fixed part of one file's PUT deadline, in milliseconds. The deadline covers the whole PUT,
   * so it also gets the time to send the file at `uploadMinBytesPerSecond`: a large video on a
   * slow uplink is not cut off by a fixed cap.
   */
  readonly uploadTimeoutMs: number;
  /** The slowest uplink an upload still waits for, in bytes per second. */
  readonly uploadMinBytesPerSecond: number;
  /** The server's minimum password length, for the sign-up hint; the server stays the authority. */
  readonly passwordMinLength: number;
};

export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_UPLOAD_TIMEOUT_MS = 120_000;
// 128 KiB/s, about 1 Mbit/s: a 100 MB video still gets roughly 13 minutes plus the fixed part.
export const DEFAULT_UPLOAD_MIN_BYTES_PER_SECOND = 128 * 1024;
export const DEFAULT_PASSWORD_MIN_LENGTH = 10;

type RawConfig = {
  url: string | undefined;
  timeoutMs: string | undefined;
  uploadTimeoutMs?: string | undefined;
  uploadMinBytesPerSecond?: string | undefined;
  passwordMinLength?: string | undefined;
  dev: boolean;
};

/** A positive whole number from the environment, or `fallback` when the variable is unset. */
function positiveInteger(raw: string | undefined, fallback: number, name: string): number {
  const value = raw ? Number(raw) : fallback;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive whole number`);
  }
  return value;
}

/** Validates the raw environment values. Pure, so tests can cover every branch. */
export function readApiConfig({
  url,
  timeoutMs,
  uploadTimeoutMs,
  uploadMinBytesPerSecond,
  passwordMinLength,
  dev,
}: RawConfig): ApiConfig {
  if (!url) throw new Error("EXPO_PUBLIC_API_URL is not set; see apps/mobile/.env.example");

  let baseUrl: URL;
  try {
    baseUrl = new URL(url);
  } catch {
    throw new Error("EXPO_PUBLIC_API_URL is not a valid URL");
  }

  const plainHttpAllowed = dev && baseUrl.protocol === "http:";
  if (baseUrl.protocol !== "https:" && !plainHttpAllowed) {
    throw new Error(
      `EXPO_PUBLIC_API_URL must use https:// outside development (got ${baseUrl.protocol}//)`,
    );
  }

  return {
    baseUrl,
    timeoutMs: positiveInteger(timeoutMs, DEFAULT_TIMEOUT_MS, "EXPO_PUBLIC_API_TIMEOUT_MS"),
    uploadTimeoutMs: positiveInteger(
      uploadTimeoutMs,
      DEFAULT_UPLOAD_TIMEOUT_MS,
      "EXPO_PUBLIC_UPLOAD_TIMEOUT_MS",
    ),
    uploadMinBytesPerSecond: positiveInteger(
      uploadMinBytesPerSecond,
      DEFAULT_UPLOAD_MIN_BYTES_PER_SECOND,
      "EXPO_PUBLIC_UPLOAD_MIN_BYTES_PER_SECOND",
    ),
    passwordMinLength: positiveInteger(
      passwordMinLength,
      DEFAULT_PASSWORD_MIN_LENGTH,
      "EXPO_PUBLIC_PASSWORD_MIN_LENGTH",
    ),
  };
}

// Literal `process.env.EXPO_PUBLIC_*` reads: Metro inlines them at build time, dynamic access would
// read nothing. Evaluated once, so a bad URL fails at startup and not on the first request.
export const apiConfig: ApiConfig = readApiConfig({
  url: process.env.EXPO_PUBLIC_API_URL,
  timeoutMs: process.env.EXPO_PUBLIC_API_TIMEOUT_MS,
  uploadTimeoutMs: process.env.EXPO_PUBLIC_UPLOAD_TIMEOUT_MS,
  uploadMinBytesPerSecond: process.env.EXPO_PUBLIC_UPLOAD_MIN_BYTES_PER_SECOND,
  passwordMinLength: process.env.EXPO_PUBLIC_PASSWORD_MIN_LENGTH,
  dev: __DEV__,
});
