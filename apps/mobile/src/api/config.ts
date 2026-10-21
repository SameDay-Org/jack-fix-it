/** How the app reaches the API, read once at startup. */
export type ApiConfig = {
  readonly baseUrl: URL;
  readonly timeoutMs: number;
};

export const DEFAULT_TIMEOUT_MS = 15_000;

type RawConfig = {
  url: string | undefined;
  timeoutMs: string | undefined;
  dev: boolean;
};

/** Validates the raw environment values. Pure, so tests can cover every branch. */
export function readApiConfig({ url, timeoutMs, dev }: RawConfig): ApiConfig {
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

  const timeout = timeoutMs ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeout) || timeout <= 0) {
    throw new Error("EXPO_PUBLIC_API_TIMEOUT_MS must be a positive whole number of milliseconds");
  }

  return { baseUrl, timeoutMs: timeout };
}

// Literal `process.env.EXPO_PUBLIC_*` reads: Metro inlines them at build time, dynamic access would
// read nothing. Evaluated once, so a bad URL fails at startup and not on the first request.
export const apiConfig: ApiConfig = readApiConfig({
  url: process.env.EXPO_PUBLIC_API_URL,
  timeoutMs: process.env.EXPO_PUBLIC_API_TIMEOUT_MS,
  dev: __DEV__,
});
