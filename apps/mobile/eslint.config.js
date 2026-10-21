const { defineConfig } = require("eslint/config");
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ["dist/*", "dist-ci/*", ".expo/*"],
  },
  {
    // Routes render inside <Screen> (src/components/ui), the one owner of the status-bar style and
    // of the top safe-area backdrop; a route that handles either itself fights the owner.
    files: ["src/app/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "expo-status-bar",
              message: "Screen owns the status bar: render the route inside <Screen bar=...>.",
            },
            {
              name: "react-native-safe-area-context",
              importNames: ["SafeAreaView", "useSafeAreaInsets"],
              message: "Screen owns the safe areas: render the route inside <Screen bar=...>.",
            },
          ],
        },
      ],
    },
  },
  {
    // Liquid Glass has one primitive (ADR 0008): everything else renders <GlassSurface>.
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/components/ui/GlassSurface.tsx", "src/components/ui/__tests__/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "expo-glass-effect",
              message: "GlassSurface owns Liquid Glass: render <GlassSurface tone=... shape=...>.",
            },
          ],
        },
      ],
    },
  },
]);
