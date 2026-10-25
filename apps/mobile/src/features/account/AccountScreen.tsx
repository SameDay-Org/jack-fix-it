import { useTranslation } from "react-i18next";
import { ScrollView, Text, View } from "react-native";

import { useSession } from "@/api";
import { Avatar, Card, Screen, StatusBadge } from "@/components/ui";
import { BackButton } from "@/features/auth/components/BackButton";

import { AccountActions } from "./AccountActions";
import { fullName, ROLE_TONE } from "./identity";
import { PhoneStatus } from "./PhoneStatus";

/**
 * Who is signed in, as which role, their phone once verified (or the way to verify it), and the
 * way out. The email and the number are shown to their owner only.
 */
export function AccountScreen() {
  const { t } = useTranslation();
  const { user } = useSession();
  if (!user) return null;

  const name = fullName(user);

  return (
    <Screen bar="light" testID="account-screen">
      <ScrollView contentContainerClassName="flex-grow gap-6 px-4 pb-4 pt-2">
        <View className="gap-2">
          <BackButton />
          <Text accessibilityRole="header" className="text-title-1 text-navy-900">
            {t("account.title")}
          </Text>
        </View>
        <Card className="gap-4">
          <View className="flex-row items-center gap-4" testID="account-identity">
            <Avatar name={name ?? user.email} />
            <View className="flex-1 gap-1">
              {name ? <Text className="text-headline text-navy-900">{name}</Text> : null}
              <Text className={name ? "text-callout text-gray-500" : "text-headline text-navy-900"}>
                {user.email}
              </Text>
            </View>
          </View>
          <StatusBadge
            label={t(`roles.${user.role}`)}
            tone={ROLE_TONE[user.role]}
            testID="account-role"
          />
          <PhoneStatus user={user} testID="account-phone" />
        </Card>
        <View className="flex-1" />
        <AccountActions user={user} testID="account" />
      </ScrollView>
    </Screen>
  );
}
