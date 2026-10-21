import "../global.css";
import "@/i18n";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack } from "expo-router";
import { useEffect, useState } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { attachQueryClient, restoreSession } from "@/api";
import { ToastHost } from "@/components/ui";

// The status bar is owned per screen by `Screen` (src/components/ui); the root mounts none.
export default function RootLayout() {
  const [queryClient] = useState(() => new QueryClient());

  // Once per app start: the session clears this cache on sign-out, and rebuilds itself from the
  // stored refresh token. Routing by session status is the screens' job (#33).
  useEffect(() => {
    attachQueryClient(queryClient);
    void restoreSession();
  }, [queryClient]);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <Stack screenOptions={{ headerShown: false }} />
          <ToastHost />
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
