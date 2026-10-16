import type { ConfigContext, ExpoConfig } from "expo/config";

type AppVariant = "development" | "preview" | "production";

// Development and preview builds install next to production, with their own name and id.
const VARIANTS: Record<AppVariant, { nameSuffix: string; idSuffix: string }> = {
  development: { nameSuffix: " (Dev)", idSuffix: ".dev" },
  preview: { nameSuffix: " (Preview)", idSuffix: ".preview" },
  production: { nameSuffix: "", idSuffix: "" },
};

// TODO(needs-human): confirm the bundle id / package name before the first store build.
const BASE_APP_ID = "com.jackfixit.app";

function appVariant(): AppVariant {
  const value = process.env.APP_VARIANT ?? "development";
  if (Object.hasOwn(VARIANTS, value)) return value as AppVariant;
  throw new Error(`APP_VARIANT must be one of ${Object.keys(VARIANTS).join(", ")}; got "${value}"`);
}

export default ({ config }: ConfigContext): ExpoConfig => {
  const variant = VARIANTS[appVariant()];
  const appId = `${BASE_APP_ID}${variant.idSuffix}`;

  return {
    ...config,
    name: `Jack Fix It${variant.nameSuffix}`,
    slug: "jack-fix-it",
    platforms: ["ios", "android"],
    version: "0.1.0",
    orientation: "portrait",
    scheme: "jackfixit",
    userInterfaceStyle: "light",
    ios: { bundleIdentifier: appId },
    android: { package: appId },
    plugins: [
      "expo-router",
      "expo-secure-store",
      "expo-localization",
      "expo-font",
      "expo-splash-screen",
      "expo-status-bar",
    ],
    experiments: { typedRoutes: true },
    extra: {
      // Set by a human once the EAS project exists (see .env.example).
      eas: { projectId: process.env.EAS_PROJECT_ID },
    },
  };
};
