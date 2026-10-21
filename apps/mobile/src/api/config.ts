/** How the app reaches the API, and the server rules it mirrors, read once at startup. */
export type ApiConfig = {
  readonly baseUrl: URL;
  readonly timeoutMs: number;
  /** The server's minimum password length, for the sign-up hint; the server stays the authority. */
  readonly passwordMinLength: number;
};

export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_PASSWORD_MIN_LENGTH = 10;

type RawConfig = {
  url: string | undefined;
  timeoutMs: string | undefined;
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
export function readApiConfig({ url, timeoutMs, passwordMinLength, dev }: RawConfig): ApiConfig {
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
  passwordMinLength: process.env.EXPO_PUBLIC_PASSWORD_MIN_LENGTH,
  dev: __DEV__,
});
