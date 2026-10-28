import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";

import { useSession } from "@/api";
import { Screen } from "@/components/ui";
import { AccountButton } from "@/features/account/AccountButton";
import { useOpenPhoneStepAfterSignUp } from "@/features/phone/useOpenPhoneStepAfterSignUp";

import { OpportunityList } from "./OpportunityList";

/**
 * The pro's home (#219): a greeting with the way to the account, then the new opportunities,
 * which scroll the header along. The wallet (#70) and the current job (#63) come later.
 *
 * Right after a sign-up it opens the phone step over itself, once, and shows only its bare page
 * until then (`useOpenPhoneStepAfterSignUp`).
 */
export function ProHomeScreen() {
  const { t } = useTranslation();
  const { user } = useSession();
  const phoneStepOffered = useOpenPhoneStepAfterSignUp();

  if (!user) return null;
  if (phoneStepOffered) {
    return (
      <Screen bar="light" testID="pro-home">
        {null}
      </Screen>
    );
  }

  const firstName = user.first_name?.trim();
  return (
    <Screen bar="light" testID="pro-home">
      <OpportunityList
        header={
          <View className="gap-6 pb-4 pt-2">
            <View className="flex-row items-center justify-between gap-3">
              <Text
                accessibilityRole="header"
                className="shrink text-title-1 text-navy-900"
                testID="pro-home-greeting"
              >
                {firstName
                  ? t("opportunities.greeting", { name: firstName })
                  : t("opportunities.greetingNoName")}
              </Text>
              <AccountButton user={user} />
            </View>
            <Text accessibilityRole="header" className="text-headline text-navy-900">
              {t("opportunities.title")}
            </Text>
          </View>
        }
      />
    </Screen>
  );
}
