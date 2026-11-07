/**
 * The arrival times "On my way" accepts, from the API's contract (`OnTheWayIn.eta_minutes`, an
 * integer from 5 to 240; anything else answers 422). The server stays the authority.
 */
export const ETA_MIN_MINUTES = 5;
export const ETA_MAX_MINUTES = 240;
/** The custom arrival time moves by this much up to an hour, and by `ETA_LONG_STEP_MINUTES` past it. */
export const ETA_STEP_MINUTES = 5;
export const ETA_LONG_STEP_MINUTES = 15;
export const MINUTES_PER_HOUR = 60;
/** The customer's arrival code: 4 digits (`CheckInIn.arrival_code`). */
export const ARRIVAL_CODE_LENGTH = 4;

/** The pro's job screens, read once at startup. */
export type ProJobsConfig = {
  /** The arrival times offered as one-tap choices, in minutes, ascending. */
  readonly etaPresetsMinutes: readonly number[];
  /** How long check-in waits for the phone's location before it says so and offers a retry. */
  readonly locationTimeoutMs: number;
};

export const DEFAULT_ETA_PRESETS = "10,20,30,45,60";
export const DEFAULT_LOCATION_TIMEOUT_SECONDS = 20;
const MS_PER_SECOND = 1000;

function etaPresets(raw: string | undefined): number[] {
  const values = (raw?.trim() ? raw : DEFAULT_ETA_PRESETS).split(",").map((part) => {
    const text = part.trim();
    return /^\d+$/.test(text) ? Number(text) : Number.NaN;
  });
  const valid =
    values.length > 0 &&
    values.every(
      (value, index) =>
        Number.isInteger(value) &&
        value >= ETA_MIN_MINUTES &&
        value <= ETA_MAX_MINUTES &&
        (index === 0 || value > values[index - 1]),
    );
  if (!valid) {
    throw new Error(
      `EXPO_PUBLIC_JOB_ETA_PRESETS must list whole minutes from ${ETA_MIN_MINUTES} to ` +
        `${ETA_MAX_MINUTES}, ascending, separated by commas`,
    );
  }
  return values;
}

function positiveWhole(raw: string | undefined, fallback: number, name: string): number {
  const value = raw?.trim() ? Number(raw) : fallback;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive whole number`);
  }
  return value;
}

/** Validates the raw environment values. Pure, so tests can cover every branch. */
export function readProJobsConfig(raw: {
  etaPresets: string | undefined;
  locationTimeoutSeconds: string | undefined;
}): ProJobsConfig {
  const seconds = positiveWhole(
    raw.locationTimeoutSeconds,
    DEFAULT_LOCATION_TIMEOUT_SECONDS,
    "EXPO_PUBLIC_CHECK_IN_LOCATION_TIMEOUT_SECONDS",
  );
  return {
    etaPresetsMinutes: etaPresets(raw.etaPresets),
    locationTimeoutMs: seconds * MS_PER_SECOND,
  };
}

// Literal `process.env.EXPO_PUBLIC_*` reads: Metro inlines them at build time.
export const proJobsConfig: ProJobsConfig = readProJobsConfig({
  etaPresets: process.env.EXPO_PUBLIC_JOB_ETA_PRESETS,
  locationTimeoutSeconds: process.env.EXPO_PUBLIC_CHECK_IN_LOCATION_TIMEOUT_SECONDS,
});

/** The custom arrival time one step later: 5 minutes at a time up to an hour, then 15. */
export function nextEta(minutes: number): number {
  const step = minutes < MINUTES_PER_HOUR ? ETA_STEP_MINUTES : ETA_LONG_STEP_MINUTES;
  return Math.min(ETA_MAX_MINUTES, (Math.floor(minutes / step) + 1) * step);
}

/** The custom arrival time one step earlier, mirroring `nextEta`. */
export function previousEta(minutes: number): number {
  const step = minutes <= MINUTES_PER_HOUR ? ETA_STEP_MINUTES : ETA_LONG_STEP_MINUTES;
  return Math.max(ETA_MIN_MINUTES, (Math.ceil(minutes / step) - 1) * step);
}
