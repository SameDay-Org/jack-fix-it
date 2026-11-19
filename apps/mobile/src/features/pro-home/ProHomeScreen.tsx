import { useIsFocused } from "expo-router";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";

import { useSession } from "@/api";
import { Screen, useTabBarInset } from "@/components/ui";
import { EarningsCard, useRefreshEarningsTotals } from "@/features/earnings";
import { useInForeground } from "@/features/jobs/api";
import { NotificationsPrompt } from "@/features/notifications/NotificationsPrompt";
import { ProfileChecklistCard, useMyProProfile } from "@/features/pro-profile";
import { useProJobs, YourJobs } from "@/features/pro-jobs";
import { homeMode, ProOnboarding } from "@/features/pro-verification";
import { useRefetchOnReturn } from "@/features/quotes/useRequestQuotes";

import { OpportunityList } from "./OpportunityList";

/**
 * The pro's home (#219), the Home tab. Once the pro is approved and can be paid: a greeting, the
 * pro's active jobs (#63), then the new opportunities, which scroll the header along; a pull
 * refreshes the jobs and the profile with them. Until then (#38) the home shows where the pro
 * stands and what is left instead (`ProOnboarding`), with the pro's jobs under it: no request is
 * listed, and none is asked for. Under the greeting, the notifications pre-prompt while it
 * applies (#334), and "Finish your profile" while the profile misses something (#36). The wallet
 * (#70) sits above the jobs in both, so a pro whose payouts went off still reaches their earnings.
 */
export function ProHomeScreen() {
  const { t } = useTranslation();
  const { user } = useSession();
  // Tabs stay mounted while another one shows: only the focused tab owns the status bar.
  const focused = useIsFocused();
  const inset = useTabBarInset();
  // The pull's refresh only: "Your jobs" refreshes the list on focus and foreground itself.
  const { refetch: refetchJobs } = useProJobs({ refetchOnReturn: false });
  // While the review is pending the home asks again on its own: approval lands without a pull.
  const foreground = useInForeground();
  const profile = useMyProProfile({ pollWhilePending: focused && foreground });
  const { refetch: refetchProfile } = profile;
  // The review's answer lands while the pro is away: asked again on every return to the home.
  useRefetchOnReturn(refetchProfile);
  const refreshEarnings = useRefreshEarningsTotals();

  if (!user) return null;

  const firstName = user.first_name?.trim();
  const greeting = (
    <>
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
    </>
  );
  const refresh = () => Promise.all([refetchJobs(), refetchProfile(), refreshEarnings()]);
  const listsRequests = profile.data !== undefined && homeMode(profile.data) === "requests";

  return (
    // No bottom edge: the page pads the tab bar itself.
    <Screen bar="light" edges={[]} ownsStatusBar={focused} testID="pro-home">
      <View className="flex-1" style={{ paddingBottom: inset }}>
        {listsRequests ? (
          <OpportunityList
            onRefresh={refresh}
            header={
              <View className="gap-6 pb-4 pt-2">
                {greeting}
                <ProfileChecklistCard />
                <EarningsCard />
                <YourJobs />
                <Text accessibilityRole="header" className="text-headline text-navy-900">
                  {t("opportunities.title")}
                </Text>
              </View>
            }
          />
        ) : (
          <ProOnboarding
            profile={profile.data}
            error={profile.error}
            loading={profile.isFetching}
            onRetry={() => void refetchProfile()}
            onRefresh={refresh}
            header={greeting}
          >
            <EarningsCard />
            <YourJobs />
          </ProOnboarding>
        )}
      </View>
    </Screen>
  );
}
