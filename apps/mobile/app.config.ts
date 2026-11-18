import type { ConfigContext, ExpoConfig } from "expo/config";
import { AndroidConfig, withAndroidManifest, type ConfigPlugin } from "expo/config-plugins";

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

// Public EAS identifiers, not secrets: the project under the johngotitcom EAS account.
const EAS_OWNER = "johngotitcom";
const EAS_PROJECT_ID = "dc856055-5039-4f97-aeff-dc6aea84f8c0";

// Firebase's Android config (#335), the path EAS gives a file environment variable: with it the
// build can fetch Expo push tokens on Android. Absent (local builds, until #335), the build has
// none and the app skips the token quietly. A change needs a new dev build.
const GOOGLE_SERVICES_JSON = process.env.GOOGLE_SERVICES_JSON || undefined;

// Apple Pay's merchant id (#59), registered in the Apple Developer account before an iOS build
// with Apple Pay; `APPLE_MERCHANT_ID` overrides it. Public, not a secret.
const APPLE_MERCHANT_ID = process.env.APPLE_MERCHANT_ID || `merchant.${BASE_APP_ID}`;

// iOS permission prompts, from the app's catalogs so they read like the rest of the app. The
// plugin sets the base strings; `locales` writes each language's InfoPlist.strings.
const PERMISSION_PROMPTS = {
  en: {
    NSCameraUsageDescription: en.permissions.camera,
    NSPhotoLibraryUsageDescription: en.permissions.photos,
    NSMotionUsageDescription: en.permissions.motion,
    NSLocationWhenInUseUsageDescription: en.permissions.location,
  },
  es: {
    NSCameraUsageDescription: es.permissions.camera,
    NSPhotoLibraryUsageDescription: es.permissions.photos,
    NSMotionUsageDescription: es.permissions.motion,
    NSLocationWhenInUseUsageDescription: es.permissions.location,
  },
};

const BOOT_COMPLETED = "android.permission.RECEIVE_BOOT_COMPLETED";

/**
 * The app's manifest without RECEIVE_BOOT_COMPLETED, removed from the merged manifest too
 * (`tools:node="remove"`). expo-task-manager declares it, and with it granted it hands the pro's
 * location fixes to Android's JobScheduler as PERSISTED jobs (`setPersisted(true)`): written to
 * disk and kept across a reboot until the app reads them. Without it the jobs live in memory
 * only. Nothing in the app needs it: push messages come from the server, and the one scheduled
 * local notification (a dev screen's) fires seconds later. Pure, so a test can check the output.
 */
export function withoutBootCompleted(
  manifest: AndroidConfig.Manifest.AndroidManifest,
): AndroidConfig.Manifest.AndroidManifest {
  const root = AndroidConfig.Manifest.ensureToolsAvailable(manifest).manifest;
  const others = (root["uses-permission"] ?? []).filter(
    (permission) => permission.$["android:name"] !== BOOT_COMPLETED,
  );
  return {
    ...manifest,
    manifest: {
      ...root,
      "uses-permission": [
        ...others,
        {
          $: { "android:name": BOOT_COMPLETED, "tools:node": "remove" } as {
            "android:name": string;
          },
        },
      ],
    },
  };
}

// A change here needs a new dev build.
const withNoBootCompleted: ConfigPlugin = (config) =>
  withAndroidManifest(config, (mod) => {
    mod.modResults = withoutBootCompleted(mod.modResults);
    return mod;
  });

function appVariant(): AppVariant {
  const value = process.env.APP_VARIANT ?? "development";
  if (Object.hasOwn(VARIANTS, value)) return value as AppVariant;
  throw new Error(`APP_VARIANT must be one of ${Object.keys(VARIANTS).join(", ")}; got "${value}"`);
}

export default ({ config }: ConfigContext): ExpoConfig => {
  const variant = VARIANTS[appVariant()];
  const appId = `${BASE_APP_ID}${variant.idSuffix}`;

  // Keeps the pro's location fixes out of persisted Android jobs (#352): see withoutBootCompleted.
  return withNoBootCompleted({
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
    android: {
      package: appId,
      ...(GOOGLE_SERVICES_JSON ? { googleServicesFile: GOOGLE_SERVICES_JSON } : {}),
      // expo-sensors declares the step counter's permission; the ID card only reads the gyroscope.
      blockedPermissions: ["android.permission.ACTIVITY_RECOGNITION"],
    },
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
      // The ID card (#250, added in #251; each needs a new dev build). The in-screen selfie
      // preview: the same camera string as the picker, photos only (no microphone string on iOS,
      // no RECORD_AUDIO on Android) and no barcode scanner, which keeps ML Kit out of the build.
      [
        "expo-camera",
        {
          cameraPermission: en.permissions.camera,
          microphonePermission: false,
          recordAudioAndroid: false,
          barcodeScannerEnabled: false,
        },
      ],
      // The gyroscope behind the card's tilt and sheen; iOS wants the motion string in Info.plist.
      ["expo-sensors", { motionPermission: en.permissions.motion }],
      // The share sheet for the card's PNG. Without options the app receives no shares.
      "expo-sharing",
      // The pro's location (a change here needs a new dev build): read once at check-in (#63), and
      // sent every few seconds while on the way to a job (#352), on the "while using" permission
      // alone. Sharing starts with the app in front, so it goes on in the background and with the
      // phone locked: iOS through the location background mode (the system shows its location
      // indicator), Android through a foreground service with its notification (no
      // ACCESS_BACKGROUND_LOCATION). Never "always", and no temporary full-accuracy prompt. Motion
      // activity stays off on Android; the iOS motion string is the ID card's, set above.
      [
        "expo-location",
        {
          locationWhenInUsePermission: en.permissions.location,
          locationAlwaysAndWhenInUsePermission: false,
          locationAlwaysPermission: false,
          locationFullAccuracyPermission: false,
          isIosBackgroundLocationEnabled: true,
          isAndroidBackgroundLocationEnabled: false,
          isAndroidForegroundServiceEnabled: true,
          isAndroidMotionActivityEnabled: false,
        },
      ],
      // Stripe's hosted payout setup opens in the system's browser session (#277; added there,
      // which needs a new dev build). No options: the launcher-activity experiment stays off.
      "expo-web-browser",
      // The Payment Sheet (#59; a change here needs a new dev build): Apple Pay's merchant id in
      // the iOS entitlements, Google Pay's wallet flag in the Android manifest. iOS resolves the
      // Stripe SDK through CocoaPods: Swift Package Manager would need dynamic frameworks for
      // every pod (expo-build-properties), a stack change of its own.
      [
        "@stripe/stripe-react-native",
        { merchantIdentifier: APPLE_MERCHANT_ID, enableGooglePay: true, disableSPM: true },
      ],
      // Notifications (#323; a change here needs a new dev build): the app opens a tapped push on
      // its screen. The tray icon is tinted navy until the logo (#8) brings a monochrome icon.
      // iOS uses production APNs: every device build is ad hoc (internal distribution: the dev
      // client, preview) or the store's; only a simulator would use development. Registration and
      // the credentials come in #334 and #335 (`googleServicesFile` above).
      ["expo-notifications", { color: colors["navy-900"], mode: "production" }],
      // The live map of the pro on the way (#353; a change here needs a new dev build): Mapbox
      // Maps SDK v11, at the version @rnmapbox/maps pins. Mapbox's Maven and pods download
      // without a secret token now; the public `pk.` token is read at runtime
      // (EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN). It adds no permission the app does not hold already.
      "@rnmapbox/maps",
    ],
    locales: {
      en: { ios: PERMISSION_PROMPTS.en },
      es: { ios: PERMISSION_PROMPTS.es },
    },
    experiments: { typedRoutes: true },
    // `appleMerchantId` reaches the Payment Sheet through expo-constants (src/features/payments).
    extra: { eas: { projectId: EAS_PROJECT_ID }, appleMerchantId: APPLE_MERCHANT_ID },
  });
};
