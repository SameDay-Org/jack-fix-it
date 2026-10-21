const { defineConfig } = require("eslint/config");
const expoConfig = require("eslint-config-expo/flat");

// Each native capability has one owner module; everything else goes through it. The lists are
// composed per file set because a later `no-restricted-imports` entry replaces an earlier one.
const GLASS = {
  name: "expo-glass-effect",
  message: "GlassSurface owns Liquid Glass: render <GlassSurface tone=... shape=...>.",
};
const SYSTEM_BAR = [
  {
    name: "expo-status-bar",
    message: "Screen owns the status bar: render the route inside <Screen bar=...>.",
  },
  {
    name: "react-native-safe-area-context",
    importNames: ["SafeAreaView", "useSafeAreaInsets"],
    message: "Screen owns the safe areas: render the route inside <Screen bar=...>.",
  },
];

const restrictImports = (paths) => ({ "no-restricted-imports": ["error", { paths }] });

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ["dist/*", "dist-ci/*", ".expo/*"],
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/components/ui/GlassSurface.tsx", "src/**/__tests__/**"],
    rules: restrictImports([GLASS]),
  },
  {
    // Routes also leave the system bar and the safe areas to Screen.
    files: ["src/app/**/*.{ts,tsx}"],
    rules: restrictImports([GLASS, ...SYSTEM_BAR]),
  },
]);
