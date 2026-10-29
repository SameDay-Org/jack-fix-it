import { useIsFocused, useScrollToTop } from "expo-router";
import { useRef, type ComponentRef } from "react";
import { Trans, useTranslation } from "react-i18next";
import { ScrollView, Text, View } from "react-native";

import { useSession } from "@/api";
import { Screen } from "@/components/ui";
import { useOpenPhoneStepAfterSignUp } from "@/features/phone/useOpenPhoneStepAfterSignUp";

import { CategoryCards } from "./CategoryCards";

/**
 * The customer's home, the Home tab: a navy hero that asks what is going on and points at the
 * categories below, the one way into a request (every request starts from a category, #232).
 * Account is a tab now, so the hero carries no account control.
 *
 * Right after a sign-up it opens the phone step over itself, once, and shows only its bare page
 * until then (`useOpenPhoneStepAfterSignUp`). Pressing the Home tab again scrolls it to the top.
 */
export function CustomerHomeScreen() {
  const { t } = useTranslation();
  const { user } = useSession();
  const phoneStepOffered = useOpenPhoneStepAfterSignUp();
  // Tabs stay mounted while another one shows: only the focused tab owns the status bar.
  const focused = useIsFocused();
  const scrollRef = useRef<ComponentRef<typeof ScrollView>>(null);
  useScrollToTop(scrollRef);

  if (!user) return null;
  if (phoneStepOffered) {
    return (
      <Screen bar="light" ownsStatusBar={focused} testID="customer-home">
        {null}
      </Screen>
    );
  }

  // No bottom edge: the categories panel pads the tab bar itself.
  return (
    <Screen bar="hero" edges={[]} ownsStatusBar={focused} testID="customer-home">
      <ScrollView
        ref={scrollRef}
        contentContainerClassName="flex-grow"
        testID="customer-home-scroll"
      >
        <View className="gap-3 px-4 pb-8 pt-8">
          <Text accessibilityRole="header" className="text-display text-white">
            <Trans
              i18nKey="home.headline"
              components={{ accent: <Text className="text-green-500" /> }}
            />
          </Text>
          <Text className="text-body text-white">{t("home.support")}</Text>
        </View>
        <CategoryCards />
      </ScrollView>
    </Screen>
  );
}
