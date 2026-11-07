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

// Public EAS identifiers, not secrets: the project under the johngotitcom EAS account.
const EAS_OWNER = "johngotitcom";
const EAS_PROJECT_ID = "dc856055-5039-4f97-aeff-dc6aea84f8c0";

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
    android: {
      package: appId,
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
      // The pro's check-in at a job (#63; a change here needs a new dev build): the location
      // while the app is in use, read once when the pro checks in. No "always" or background
      // location (no background mode on iOS, no ACCESS_BACKGROUND_LOCATION or foreground service
      // on Android) and no temporary full-accuracy prompt. Motion activity stays off on Android;
      // the iOS motion string is the ID card's, set above.
      [
        "expo-location",
        {
          locationWhenInUsePermission: en.permissions.location,
          locationAlwaysAndWhenInUsePermission: false,
          locationAlwaysPermission: false,
          locationFullAccuracyPermission: false,
          isIosBackgroundLocationEnabled: false,
          isAndroidBackgroundLocationEnabled: false,
          isAndroidForegroundServiceEnabled: false,
          isAndroidMotionActivityEnabled: false,
        },
      ],
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
      // the credentials come in #334 and #335.
      ["expo-notifications", { color: colors["navy-900"], mode: "production" }],
    ],
    locales: {
      en: { ios: PERMISSION_PROMPTS.en },
      es: { ios: PERMISSION_PROMPTS.es },
    },
    experiments: { typedRoutes: true },
    // `appleMerchantId` reaches the Payment Sheet through expo-constants (src/features/payments).
    extra: { eas: { projectId: EAS_PROJECT_ID }, appleMerchantId: APPLE_MERCHANT_ID },
  };
};
