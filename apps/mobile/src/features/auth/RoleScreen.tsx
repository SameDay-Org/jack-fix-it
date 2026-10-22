import { router, useLocalSearchParams } from "expo-router";
import { useRef, useState, type ComponentRef } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, Text, View } from "react-native";
import Animated, { useReducedMotion } from "react-native-reanimated";

import { Button, ChoiceCard, Screen } from "@/components/ui";

import { BackButton } from "./components/BackButton";
import type { SignUpRole } from "./roles";
import { useContentTransition } from "./useContentTransition";

/**
 * Customer or pro, as two selectable bubbles; Continue waits for a choice and carries it to sign-up.
 * Reached from Welcome's panel, the content enters once the panel has become this page.
 */
export function RoleScreen() {
  const { t } = useTranslation();
  const { from } = useLocalSearchParams<{ from?: string }>();
  const [role, setRole] = useState<SignUpRole | null>(null);
  const titleRef = useRef<ComponentRef<typeof Text>>(null);
  const fromWelcome = from === "welcome";
  const { style, enter, exit } = useContentTransition({
    animate: fromWelcome,
    reduceMotion: useReducedMotion(),
    titleRef,
  });

  return (
    <Screen bar="light" testID="role-screen">
      <Animated.View className="flex-1" style={style} onLayout={enter} testID="role-content">
        <ScrollView
          contentContainerClassName="flex-grow gap-6 px-4 pb-4 pt-2"
          keyboardShouldPersistTaps="handled"
        >
          <BackButton beforeBack={fromWelcome ? exit : undefined} />
          <Text ref={titleRef} accessibilityRole="header" className="text-title-1 text-navy-900">
            {t("role.title")}
          </Text>
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
      </Animated.View>
    </Screen>
  );
}
