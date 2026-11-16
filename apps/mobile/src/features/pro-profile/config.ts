/** The API's limit for a bio (`ProProfileUpdate.bio`). The server stays the authority. */
export const BIO_MAX = 1000;
/** The most years of experience the API takes (`ProProfileUpdate.years_of_experience`). */
export const YEARS_MAX = 80;

/** The pro profile's limits, read once at startup. */
export type ProProfileConfig = {
  /** Most categories a profile holds; mirrors the API's PRO_MAX_CATEGORIES. */
  readonly maxCategories: number;
  /** Most service ZIP codes a profile holds; mirrors the API's PRO_MAX_SERVICE_AREAS. */
  readonly maxServiceAreas: number;
};

export const DEFAULT_MAX_CATEGORIES = 5;
export const DEFAULT_MAX_SERVICE_AREAS = 50;

function positiveWhole(raw: string | undefined, fallback: number, name: string): number {
  const value = raw?.trim() ? Number(raw) : fallback;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive whole number`);
  }
  return value;
}

/** Validates the raw environment values. Pure, so tests can cover every branch. */
export function readProProfileConfig(raw: {
  maxCategories: string | undefined;
  maxServiceAreas: string | undefined;
}): ProProfileConfig {
  return {
    maxCategories: positiveWhole(
      raw.maxCategories,
      DEFAULT_MAX_CATEGORIES,
      "EXPO_PUBLIC_PRO_MAX_CATEGORIES",
    ),
    maxServiceAreas: positiveWhole(
      raw.maxServiceAreas,
      DEFAULT_MAX_SERVICE_AREAS,
      "EXPO_PUBLIC_PRO_MAX_SERVICE_AREAS",
    ),
  };
}

// Literal `process.env.EXPO_PUBLIC_*` reads: Metro inlines them at build time.
export const proProfileConfig: ProProfileConfig = readProProfileConfig({
  maxCategories: process.env.EXPO_PUBLIC_PRO_MAX_CATEGORIES,
  maxServiceAreas: process.env.EXPO_PUBLIC_PRO_MAX_SERVICE_AREAS,
});
