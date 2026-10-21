import { router } from "expo-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, Text, View } from "react-native";

import { Button, ChoiceCard, Screen } from "@/components/ui";

import { BackButton } from "./components/BackButton";
import type { SignUpRole } from "./roles";

/** Customer or pro, as two selectable bubbles; Continue waits for a choice and carries it to sign-up. */
export function RoleScreen() {
  const { t } = useTranslation();
  const [role, setRole] = useState<SignUpRole | null>(null);

  return (
    <Screen bar="light" testID="role-screen">
      <ScrollView
        contentContainerClassName="flex-grow gap-6 px-4 pb-4 pt-2"
        keyboardShouldPersistTaps="handled"
      >
        <BackButton />
        <Text className="text-title-1 text-navy-900">{t("role.title")}</Text>
        <View accessibilityRole="radiogroup" className="gap-3" testID="role-options">
          <ChoiceCard
            title={t("role.customerTitle")}
            description={t("role.customerDescription")}
            selected={role === "customer"}
            onPress={() => setRole("customer")}
            testID="role-customer"
          />
          <ChoiceCard
            title={t("role.proTitle")}
            description={t("role.proDescription")}
            selected={role === "pro"}
            onPress={() => setRole("pro")}
            testID="role-pro"
          />
        </View>
        <View className="flex-1" />
        <Button
          label={t("common.continue")}
          size="lg"
          disabled={role === null}
          onPress={() => {
            if (role) router.push({ pathname: "/(auth)/sign-up", params: { role } });
          }}
          testID="role-continue"
        />
      </ScrollView>
    </Screen>
  );
}
