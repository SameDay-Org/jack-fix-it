import { useIsFocused } from "expo-router";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";

import { useSession } from "@/api";
import { Screen, useTabBarInset } from "@/components/ui";
import { NotificationsPrompt } from "@/features/notifications/NotificationsPrompt";
import { useProJobs, YourJobs } from "@/features/pro-jobs";

import { OpportunityList } from "./OpportunityList";

/**
 * The pro's home (#219), the Home tab: a greeting, the pro's active jobs (#63), then the new
 * opportunities, which scroll the header along. A pull refreshes the jobs with the
 * opportunities. Under the greeting, the notifications pre-prompt while it applies (#334). The
 * wallet (#70) comes later.
 */
export function ProHomeScreen() {
  const { t } = useTranslation();
  const { user } = useSession();
  // Tabs stay mounted while another one shows: only the focused tab owns the status bar.
  const focused = useIsFocused();
  const inset = useTabBarInset();
  // The pull's refresh only: "Your jobs" refreshes the list on focus and foreground itself.
  const { refetch: refetchJobs } = useProJobs({ refetchOnReturn: false });

  if (!user) return null;

  const firstName = user.first_name?.trim();
  return (
    // No bottom edge: the page pads the tab bar itself.
    <Screen bar="light" edges={[]} ownsStatusBar={focused} testID="pro-home">
      <View className="flex-1" style={{ paddingBottom: inset }}>
        <OpportunityList
          onRefresh={refetchJobs}
          header={
            <View className="gap-6 pb-4 pt-2">
              <Text
                accessibilityRole="header"
                className="text-title-1 text-navy-900"
                testID="pro-home-greeting"
              >
                {firstName
                  ? t("opportunities.greeting", { name: firstName })
                  : t("opportunities.greetingNoName")}
              </Text>
              <NotificationsPrompt audience="pro" testID="pro-home-notifications" />
              <YourJobs />
              <Text accessibilityRole="header" className="text-headline text-navy-900">
                {t("opportunities.title")}
              </Text>
            </View>
          }
        />
      </View>
    </Screen>
  );
}
