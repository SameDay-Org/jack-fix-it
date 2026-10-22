import type { ConfigContext, ExpoConfig } from "expo/config";

import en from "./src/i18n/locales/en.json";
import es from "./src/i18n/locales/es.json";
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

// Public EAS identifiers, not secrets: the project Cesar created under the organization's account.
const EAS_OWNER = "same-day-auto-group";
const EAS_PROJECT_ID = "491f33d8-b909-4c74-a1bb-6d373331404f";

// iOS permission prompts, from the app's catalogs so they read like the rest of the app. The
// plugin sets the base strings; `locales` writes each language's InfoPlist.strings.
const PERMISSION_PROMPTS = {
  en: {
    NSCameraUsageDescription: en.permissions.camera,
    NSPhotoLibraryUsageDescription: en.permissions.photos,
  },
  es: {
    NSCameraUsageDescription: es.permissions.camera,
    NSPhotoLibraryUsageDescription: es.permissions.photos,
  },
};

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
    ios: {
      bundleIdentifier: appId,
      // Lets iOS use the Spanish InfoPlist strings below in an app whose base language is English.
      infoPlist: { CFBundleAllowMixedLocalizations: true },
    },
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
      // Camera for photos only (no microphone, so no RECORD_AUDIO on Android). The library goes
      // through the system photo picker, which needs no permission; the string is iOS's own.
      [
        "expo-image-picker",
        {
          cameraPermission: en.permissions.camera,
          photosPermission: en.permissions.photos,
          microphonePermission: false,
        },
      ],
    ],
    locales: {
      en: { ios: PERMISSION_PROMPTS.en },
      es: { ios: PERMISSION_PROMPTS.es },
    },
    experiments: { typedRoutes: true },
    extra: { eas: { projectId: EAS_PROJECT_ID } },
  };
};
