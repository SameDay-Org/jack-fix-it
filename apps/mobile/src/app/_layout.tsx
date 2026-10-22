import "../global.css";
import "@/i18n";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as SplashScreen from "expo-splash-screen";
import { useEffect, useState } from "react";
import { LogBox } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { attachQueryClient, restoreSession } from "@/api";
import { LaunchShell } from "@/features/launch";

// The native splash (plain navy, app.config.ts) stays up until the launch intro's first frame is
// final, so the handoff is one navy surface into the next; nothing flashes in between. LaunchShell
// releases it on every path, at the latest at motion.launchMaxMs.
void SplashScreen.preventAutoHideAsync();

// Dev builds only (LogBox is a no-op in release): NativeWind's css-interop registers every React
// Native component at start-up, which trips RN 0.88's ImageBackground deprecation warning; the
// LogBox bar it opens would sit over the launch intro's Skip control. Not ours to fix.
if (__DEV__) LogBox.ignoreLogs(["ImageBackground is deprecated"]);

// The status bar is owned per screen by `Screen` (src/components/ui); the root mounts none.
export default function RootLayout() {
  const [queryClient] = useState(() => new QueryClient());

  // Once per app start: the session clears this cache on sign-out, and rebuilds itself from the
  // stored refresh token. SessionGate routes by the resulting status, under the intro.
  useEffect(() => {
    attachQueryClient(queryClient);
    void restoreSession();
  }, [queryClient]);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <LaunchShell />
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
