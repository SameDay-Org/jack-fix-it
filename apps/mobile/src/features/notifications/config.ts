import Constants from "expo-constants";

/** How the app registers for pushes, read once at startup. */
export type NotificationsConfig = {
  /**
   * How long a logout waits for this device's push token to come off the account, in
   * milliseconds, before it signs out anyway.
   */
  readonly removalTimeoutMs: number;
  /** The EAS project id (`extra.eas.projectId` in app.config.ts) Expo's push tokens belong to. */
  readonly projectId: string | undefined;
};

export const DEFAULT_REMOVAL_TIMEOUT_MS = 3_000;

type RawNotificationsConfig = {
  removalTimeoutMs: string | undefined;
  extra: unknown;
};

function positiveInteger(raw: string | undefined, fallback: number, name: string): number {
  const value = raw ? Number(raw) : fallback;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive whole number`);
  }
  return value;
}

function projectIdOf(extra: unknown): string | undefined {
  const eas = (extra as { eas?: { projectId?: unknown } } | null | undefined)?.eas;
  return typeof eas?.projectId === "string" && eas.projectId !== "" ? eas.projectId : undefined;
}

/** Validates the raw values. Pure, so tests can cover every branch. */
export function readNotificationsConfig(raw: RawNotificationsConfig): NotificationsConfig {
  return {
    removalTimeoutMs: positiveInteger(
      raw.removalTimeoutMs,
      DEFAULT_REMOVAL_TIMEOUT_MS,
      "EXPO_PUBLIC_PUSH_REMOVAL_TIMEOUT_MS",
    ),
    projectId: projectIdOf(raw.extra),
  };
}

// EXPO_PUBLIC_* values are inlined at build time, so each one is read by its literal name.
export const notificationsConfig = readNotificationsConfig({
  removalTimeoutMs: process.env.EXPO_PUBLIC_PUSH_REMOVAL_TIMEOUT_MS,
  extra: Constants.expoConfig?.extra,
});
