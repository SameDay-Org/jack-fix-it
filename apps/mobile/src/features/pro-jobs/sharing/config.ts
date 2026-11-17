/** Sharing the pro's position while on the way (#352), read once at startup. */
export type SharingConfig = {
  /** Whether the app shares at all. Off: no permission prompt, no note, no task. */
  readonly enabled: boolean;
  /** How often a position is sent while the pro is on the way. */
  readonly intervalMs: number;
};

/** The only value that turns sharing on: anything else, unset included, leaves it off. */
export const SHARING_ON = "on";
export const DEFAULT_SHARING_SECONDS = 10;
const MS_PER_SECOND = 1000;

/** Validates the raw environment values. Pure, so tests can cover every branch. */
export function readSharingConfig(raw: {
  sharing: string | undefined;
  seconds: string | undefined;
}): SharingConfig {
  const seconds = raw.seconds?.trim() ? Number(raw.seconds) : DEFAULT_SHARING_SECONDS;
  if (!Number.isInteger(seconds) || seconds <= 0) {
    throw new Error("EXPO_PUBLIC_PRO_LOCATION_SECONDS must be a positive whole number");
  }
  return { enabled: raw.sharing === SHARING_ON, intervalMs: seconds * MS_PER_SECOND };
}

// Literal `process.env.EXPO_PUBLIC_*` reads: Metro inlines them at build time. Off until Cesar
// sets the flag in EAS, once the API runs as staging or production (positions then live in their
// own short-lived Redis, never in the durable one).
export const sharingConfig: SharingConfig = readSharingConfig({
  sharing: process.env.EXPO_PUBLIC_PRO_LOCATION_SHARING,
  seconds: process.env.EXPO_PUBLIC_PRO_LOCATION_SECONDS,
});
