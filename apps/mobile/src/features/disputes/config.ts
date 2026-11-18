/** A report's description: 1 to 2000 characters. The API stays the authority (`DisputeIn`). */
export const DESCRIPTION_MAX = 2000;
export const DEFAULT_PHOTO_MAX = 10;

/** Most photos one report carries: mirrors the API's DISPUTE_PHOTO_MAX_COUNT. Pure, for tests. */
export function readPhotoMax(raw: string | undefined): number {
  const value = raw?.trim() ? Number(raw) : DEFAULT_PHOTO_MAX;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("EXPO_PUBLIC_DISPUTE_PHOTO_MAX_COUNT must be a positive whole number");
  }
  return value;
}

// A literal `process.env.EXPO_PUBLIC_*` read: Metro inlines it at build time.
export const disputePhotoMax = readPhotoMax(process.env.EXPO_PUBLIC_DISPUTE_PHOTO_MAX_COUNT);
