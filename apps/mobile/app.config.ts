import type { ConfigContext, ExpoConfig } from "expo/config";

import { colors } from "./src/theme/tokens.json";

type AppVariant = "development" | "preview" | "production";

// Development and preview builds install next to production, with their own name and id.
const VARIANTS: Record<AppVariant, { nameSuffix: string; idSuffix: string }> = {
  development: { nameSuffix: " (Dev)", idSuffix: ".dev" },
  preview: { nameSuffix: " (Preview)", idSuffix: ".preview" },
  production: { nameSuffix: "", idSuffix: "" },
};

// TODO(needs-human): confirm the bundle id / package name before the first store build.
const BASE_APP_ID = "com.jackfixit.app";

// Public EAS identifiers, not secrets: the project under the johngotitcom EAS account.
const EAS_OWNER = "johngotitcom";
const EAS_PROJECT_ID = "dc856055-5039-4f97-aeff-dc6aea84f8c0";

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
    owner: EAS_OWNER,
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
      // The native splash is the intro's first frame (#147): plain navy-900, no image until the
      // logo lands (#8). A change here needs a new dev build.
      ["expo-splash-screen", { backgroundColor: colors["navy-900"] }],
      "expo-status-bar",
    ],
    experiments: { typedRoutes: true },
    extra: { eas: { projectId: EAS_PROJECT_ID } },
  };
};
