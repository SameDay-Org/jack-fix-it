/** How the ongoing job keeps itself fresh and words its arrival time, read once at startup. */
export type JobsConfig = {
  /** How often a focused job screen asks again while the job moves (no push yet, #65). */
  readonly pollMs: number;
  /** Below this many minutes to the ETA, the arrival time also reads as "in 12 min". */
  readonly etaCloseMinutes: number;
};

export const DEFAULT_POLL_SECONDS = 15;
export const DEFAULT_ETA_CLOSE_MINUTES = 60;
const MS_PER_SECOND = 1000;

function positiveWhole(raw: string | undefined, fallback: number, name: string): number {
  const value = raw ? Number(raw) : fallback;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive whole number`);
  }
  return value;
}

/** Validates the raw environment values. Pure, so tests can cover every branch. */
export function readJobsConfig(raw: {
  pollSeconds: string | undefined;
  etaCloseMinutes: string | undefined;
}): JobsConfig {
  const pollSeconds = positiveWhole(
    raw.pollSeconds,
    DEFAULT_POLL_SECONDS,
    "EXPO_PUBLIC_JOB_POLL_SECONDS",
  );
  const etaCloseMinutes = positiveWhole(
    raw.etaCloseMinutes,
    DEFAULT_ETA_CLOSE_MINUTES,
    "EXPO_PUBLIC_JOB_ETA_CLOSE_MINUTES",
  );
  return { pollMs: pollSeconds * MS_PER_SECOND, etaCloseMinutes };
}

// Literal `process.env.EXPO_PUBLIC_*` reads: Metro inlines them at build time.
export const jobsConfig: JobsConfig = readJobsConfig({
  pollSeconds: process.env.EXPO_PUBLIC_JOB_POLL_SECONDS,
  etaCloseMinutes: process.env.EXPO_PUBLIC_JOB_ETA_CLOSE_MINUTES,
});
