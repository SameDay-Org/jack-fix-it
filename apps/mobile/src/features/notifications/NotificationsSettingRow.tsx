import { useState } from "react";
import { useTranslation } from "react-i18next";

import { ListRow } from "@/components/ui";

import {
  openNotificationSettings,
  requestPermission,
  useNotificationPermission,
} from "./permission";

/**
 * Settings' notifications row (#334): says whether they are on. While the system prompt can still
 * appear, a tap asks for them; once they are on, or turned off for good, it opens this app's page
 * in the phone's settings (the app reads the answer again on return).
 */
export function NotificationsSettingRow() {
  const { t } = useTranslation();
  const permission = useNotificationPermission();
  const [asking, setAsking] = useState(false);

  if (permission === "unknown") {
    return <ListRow label={t("notifications.settings.label")} testID="settings-notifications" />;
  }

  const ask = async () => {
    setAsking(true);
    try {
      await requestPermission();
    } finally {
      setAsking(false);
    }
  };

  const value = {
    granted: t("notifications.settings.on"),
    askable: t("notifications.settings.off"),
    blocked: t("notifications.settings.blocked"),
  }[permission];

  return (
    <ListRow
      label={t("notifications.settings.label")}
      value={value}
      busy={asking}
      // Asking is an action in place; the phone's settings are a page of their own.
      chevron={permission !== "askable"}
      onPress={permission === "askable" ? () => void ask() : () => void openNotificationSettings()}
      accessibilityHint={
        permission === "askable"
          ? t("notifications.settings.askHint")
          : t("notifications.settings.openHint")
      }
      testID="settings-notifications"
    />
  );
}
