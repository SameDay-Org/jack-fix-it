import { positiveWhole } from "../config";

/** The live map's settings, read once at startup. */
export type LiveMapConfig = {
  /** Mapbox's public token (`pk.`); null when unset or not a public one: no map is drawn. */
  readonly accessToken: string | null;
  /** How often the map asks for the pro's position and route while it is on screen. */
  readonly pollMs: number;
  /** A position older than this dims the pro's marker and says the map waits for a new one. */
  readonly staleMs: number;
};

export const DEFAULT_LIVE_MAP_POLL_SECONDS = 10;
export const DEFAULT_LIVE_MAP_STALE_SECONDS = 60;
const MS_PER_SECOND = 1000;
// Only a public token belongs in an app; a secret one (`sk.`) is refused, never used.
const PUBLIC_TOKEN_PREFIX = "pk.";

/** Validates the raw environment values. Pure, so tests can cover every branch. */
export function readLiveMapConfig(raw: {
  accessToken: string | undefined;
  pollSeconds: string | undefined;
  staleSeconds: string | undefined;
}): LiveMapConfig {
  const token = raw.accessToken?.trim() ?? "";
  const pollSeconds = positiveWhole(
    raw.pollSeconds,
    DEFAULT_LIVE_MAP_POLL_SECONDS,
    "EXPO_PUBLIC_LIVE_MAP_POLL_SECONDS",
  );
  const staleSeconds = positiveWhole(
    raw.staleSeconds,
    DEFAULT_LIVE_MAP_STALE_SECONDS,
    "EXPO_PUBLIC_LIVE_MAP_STALE_SECONDS",
  );
  return {
    accessToken: token.startsWith(PUBLIC_TOKEN_PREFIX) ? token : null,
    pollMs: pollSeconds * MS_PER_SECOND,
    staleMs: staleSeconds * MS_PER_SECOND,
  };
}

// Literal `process.env.EXPO_PUBLIC_*` reads: Metro inlines them at build time.
export const liveMapConfig: LiveMapConfig = readLiveMapConfig({
  accessToken: process.env.EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN,
  pollSeconds: process.env.EXPO_PUBLIC_LIVE_MAP_POLL_SECONDS,
  staleSeconds: process.env.EXPO_PUBLIC_LIVE_MAP_STALE_SECONDS,
});
