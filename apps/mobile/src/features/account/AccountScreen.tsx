import { useIsFocused, useScrollToTop } from "expo-router";
import { useRef, type ComponentRef } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, Text, View } from "react-native";

import { useSession } from "@/api";
import { Avatar, Card, Screen, StatusBadge, useTabBarInset } from "@/components/ui";

import { AccountActions } from "./AccountActions";
import { fullName, ROLE_TONE } from "./identity";
import { PhoneStatus } from "./PhoneStatus";

/**
 * The Account tab: who is signed in, as which role, their phone once verified (or the way to
 * verify it), and the way out. The email and the number are shown to their owner only. A tab
 * root, so it has no back control; pressing the Account tab again scrolls it to the top.
 */
export function AccountScreen() {
  const { t } = useTranslation();
  const { user } = useSession();
  // Tabs stay mounted while another one shows: only the focused tab owns the status bar.
  const focused = useIsFocused();
  const inset = useTabBarInset();
  const scrollRef = useRef<ComponentRef<typeof ScrollView>>(null);
  useScrollToTop(scrollRef);

  if (!user) return null;

  const name = fullName(user);

  // No bottom edge: the content pads the tab bar itself, so the actions at its foot stay reachable.
  return (
    <Screen bar="light" edges={[]} ownsStatusBar={focused} testID="account-screen">
      <ScrollView
        ref={scrollRef}
        contentContainerClassName="flex-grow gap-6 px-4 pt-6"
        contentContainerStyle={{ paddingBottom: inset }}
        testID="account-scroll"
      >
        <Text accessibilityRole="header" className="text-title-1 text-navy-900">
          {t("account.title")}
        </Text>
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
        <View className="pb-4">
          <AccountActions user={user} testID="account" />
        </View>
      </ScrollView>
    </Screen>
  );
}
