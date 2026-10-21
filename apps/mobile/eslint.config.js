const { defineConfig } = require("eslint/config");
const expoConfig = require("eslint-config-expo/flat");

// Each native capability has one owner module; everything else goes through it.
const GLASS = {
  name: "expo-glass-effect",
  message: "GlassSurface owns Liquid Glass: render <GlassSurface tone=... shape=...>.",
};
const SECURE_STORE = {
  name: "expo-secure-store",
  message: "src/api/tokenStorage.ts owns the secure store; use the session (src/api).",
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
    ignores: [
      "src/components/ui/GlassSurface.tsx",
      "src/api/tokenStorage.ts",
      "src/**/__tests__/**",
    ],
    rules: restrictImports([GLASS, SECURE_STORE]),
  },
  {
    // Routes also leave the system bar and the safe areas to Screen.
    files: ["src/app/**/*.{ts,tsx}"],
    rules: restrictImports([GLASS, SECURE_STORE, ...SYSTEM_BAR]),
  },
  {
    // The API is reached only through src/api: typed paths, one host, tokens in one place.
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/api/**"],
    rules: {
      "no-restricted-globals": [
        "error",
        { name: "fetch", message: "Call the API through src/api (apiGet, apiPost)." },
      ],
    },
  },
]);
