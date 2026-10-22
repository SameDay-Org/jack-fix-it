import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { AccessibilityInfo, Linking, Text, View } from "react-native";

import { Button, Card } from "@/components/ui";

export type MediaPermissionNoticeProps = { onDismiss: () => void };

/**
 * Shown when camera access was refused: what is off, how to turn it on, and a way straight to
 * the app's page in the device settings. Never a dead button: "Open settings" always leads there.
 * It is announced when it appears, since it shows up away from where the user's focus was.
 */
export function MediaPermissionNotice({ onDismiss }: MediaPermissionNoticeProps) {
  const { t } = useTranslation();
  const title = t("media.permission.cameraTitle");
  const body = t("media.permission.cameraBody");

  useEffect(() => {
    AccessibilityInfo.announceForAccessibility(`${title}. ${body}`);
  }, [title, body]);

  const openSettings = () => {
    onDismiss();
    void Linking.openSettings();
  };

  return (
    <Card testID="media-permission-notice">
      <View className="gap-3">
        <View className="gap-1">
          <Text className="text-headline text-navy-900">{title}</Text>
          <Text className="text-callout text-gray-500">{body}</Text>
        </View>
        <View className="flex-row flex-wrap justify-end gap-2">
          <Button label={t("media.permission.notNow")} variant="ghost" onPress={onDismiss} />
          <Button
            label={t("media.permission.openSettings")}
            variant="secondary"
            onPress={openSettings}
            testID="media-open-settings"
          />
        </View>
      </View>
    </Card>
  );
}
