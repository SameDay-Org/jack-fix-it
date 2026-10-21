import "../global.css";
import "@/i18n";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as SplashScreen from "expo-splash-screen";
import { useEffect, useState } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { attachQueryClient, restoreSession } from "@/api";
import { ToastHost } from "@/components/ui";
import { SessionGate } from "@/features/auth";

// The splash stays up while the stored session is restored; SessionGate hides it with the first
// real screen, so nothing flashes in between.
void SplashScreen.preventAutoHideAsync();

// The status bar is owned per screen by `Screen` (src/components/ui); the root mounts none.
export default function RootLayout() {
  const [queryClient] = useState(() => new QueryClient());

  // Once per app start: the session clears this cache on sign-out, and rebuilds itself from the
  // stored refresh token. SessionGate routes by the resulting status.
  useEffect(() => {
    attachQueryClient(queryClient);
    void restoreSession();
  }, [queryClient]);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <SessionGate />
          <ToastHost />
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
