import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";

import { Button } from "@/components/ui";
import { continuousCorners } from "@/theme";

import { requestPermission, useNotificationPermission } from "./permission";
import { dismissPrompt, usePromptDismissed } from "./promptDismissal";

export type NotificationsPromptProps = {
  /** Whose updates the card promises: the customer's job, or the pro's new jobs and hires. */
  audience: "customer" | "pro";
  testID: string;
};

/**
 * The pre-prompt (#334): one calm card that says what notifications bring before the system asks.
 * Shown where they start to matter (a customer's booked job, the pro's home) only while the
 * system prompt can still appear and the person has not closed the card. "Turn on" shows the
 * system prompt once; whatever the answer, the card does not come back (Settings keeps the way to
 * turn them on). Never shown at launch.
 */
export function NotificationsPrompt({ audience, testID }: NotificationsPromptProps) {
  const { t } = useTranslation();
  const permission = useNotificationPermission();
  const dismissed = usePromptDismissed();
  const [asking, setAsking] = useState(false);

  if (permission !== "askable" || dismissed !== false) return null;

  const turnOn = async () => {
    setAsking(true);
    try {
      await requestPermission();
    } finally {
      dismissPrompt();
      setAsking(false);
    }
  };

  return (
    <View style={continuousCorners} className="gap-3 rounded-lg bg-navy-900/5 p-4" testID={testID}>
      <View className="gap-1">
        <Text accessibilityRole="header" className="text-headline text-navy-900">
          {t("notifications.prompt.title")}
        </Text>
        <Text className="text-callout text-navy-900">{t(`notifications.prompt.${audience}`)}</Text>
      </View>
      <View className="flex-row flex-wrap gap-2">
        <Button
          label={t("notifications.prompt.turnOn")}
          loading={asking}
          onPress={() => void turnOn()}
          testID={`${testID}-turn-on`}
        />
        <Button
          label={t("notifications.prompt.notNow")}
          variant="ghost"
          disabled={asking}
          onPress={dismissPrompt}
          testID={`${testID}-not-now`}
        />
      </View>
    </View>
  );
}
