/** How the request flow offers its choices, read once at startup. */
export type RequestConfig = {
  /** How many days, from the first the API accepts, the When step offers. */
  readonly dateDays: number;
};

export const DEFAULT_DATE_DAYS = 30;

/** Validates the raw environment value. Pure, so tests can cover every branch. */
export function readRequestConfig(raw: { dateDays: string | undefined }): RequestConfig {
  const dateDays = raw.dateDays ? Number(raw.dateDays) : DEFAULT_DATE_DAYS;
  if (!Number.isInteger(dateDays) || dateDays <= 0) {
    throw new Error("EXPO_PUBLIC_REQUEST_DATE_DAYS must be a positive whole number");
  }
  return { dateDays };
}

// Literal `process.env.EXPO_PUBLIC_*` reads: Metro inlines them at build time.
export const requestConfig: RequestConfig = readRequestConfig({
  dateDays: process.env.EXPO_PUBLIC_REQUEST_DATE_DAYS,
});
