import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { Pressable, View } from "react-native";

import type { SessionUser } from "@/api";
import { Avatar, useFlag } from "@/components/ui";
import { pressedTransform } from "@/theme";

import { fullName } from "./identity";

type AccountButtonProps = {
  user: SessionUser;
};

/**
 * The way to the account page: the person's initials (from their name, or the email's first
 * letter for an account without one) in a 48 dp circle. Read as one button, "Account".
 */
export function AccountButton({ user }: AccountButtonProps) {
  const { t } = useTranslation();
  const [pressed, pressIn, pressOut] = useFlag();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("account.title")}
      onPress={() => router.push("/account")}
      onPressIn={pressIn}
      onPressOut={pressOut}
      style={pressed ? pressedTransform : undefined}
      className="min-h-12 min-w-12 items-center justify-center rounded-pill"
      testID="home-account"
    >
      <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
        <Avatar name={fullName(user) ?? user.email} />
      </View>
    </Pressable>
  );
}
