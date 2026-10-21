import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";

import { logout, restoreSession } from "@/api";
import { Button, Screen } from "@/components/ui";

/**
 * A saved session that could not be restored because the server was unreachable. Nobody is asked
 * to log in again for lack of signal: retry first, or leave this account on purpose.
 */
export function OfflineScreen() {
  const { t } = useTranslation();
  const [retrying, setRetrying] = useState(false);

  const retry = async () => {
    setRetrying(true);
    try {
      await restoreSession();
    } finally {
      setRetrying(false);
    }
  };

  // Memory and the cache clear at once, so welcome shows right away; a failed local delete is
  // surfaced there through `cleanupPending`, not here.
  const useAnotherAccount = () => void logout().catch(() => undefined);

  return (
    <Screen bar="light" testID="offline-screen">
      <View className="flex-1 justify-center gap-8 px-6">
        <View className="gap-3">
          <View className="h-1 w-12 rounded-pill bg-green-500" />
          <Text className="text-title-1 text-navy-900">{t("offline.title")}</Text>
          <Text className="text-body text-gray-500">{t("offline.body")}</Text>
        </View>
        <View className="gap-3">
          <Button
            label={t("offline.retry")}
            size="lg"
            loading={retrying}
            onPress={() => void retry()}
            testID="offline-retry"
          />
          <Button
            label={t("offline.otherAccount")}
            variant="ghost"
            disabled={retrying}
            onPress={useAnotherAccount}
            testID="offline-other-account"
          />
        </View>
      </View>
    </Screen>
  );
}
