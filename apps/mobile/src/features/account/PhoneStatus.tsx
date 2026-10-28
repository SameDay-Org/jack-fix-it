import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";

import type { SessionUser } from "@/api";
import { StatusBadge } from "@/components/ui";
import { phoneConfig } from "@/features/phone/config";
import { formatE164 } from "@/features/phone/phoneNumber";

type PhoneStatusProps = {
  user: SessionUser;
  testID?: string;
};

/** The verified number, shown to its owner only; nothing until the phone is verified. */
export function PhoneStatus({ user, testID }: PhoneStatusProps) {
  const { t } = useTranslation();
  if (!user.phone_verified || !user.phone) return null;

  return (
    <View className="gap-2" testID={testID}>
      <Text className="text-callout font-semibold text-navy-900">{t("home.phone")}</Text>
      <View className="flex-row flex-wrap items-center gap-x-3 gap-y-2">
        <Text className="text-body text-navy-900">
          {formatE164(user.phone, phoneConfig.countryCode)}
        </Text>
        <StatusBadge label={t("home.phoneVerified")} tone="success" />
      </View>
    </View>
  );
}
