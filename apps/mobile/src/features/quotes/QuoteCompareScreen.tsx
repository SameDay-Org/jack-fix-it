import { useLocalSearchParams } from "expo-router";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";

import { Screen } from "@/components/ui";
import { BackButton } from "@/features/auth/components/BackButton";
import { JobBookedNotice } from "@/features/jobs/JobBookedNotice";

import { useProfileFromLink } from "./links";
import { QuoteList } from "./QuoteList";
import { useRequestQuotes } from "./useRequestQuotes";

/**
 * The customer's quotes on one request (`/requests/[id]`, where the new-quote push lands): a
 * title and one supporting line, then the quote list, which scrolls them along. A link to a pro's
 * profile lands here and opens the profile over the list (`useProfileFromLink`). Once a quote is
 * accepted and paid, the job's notice leads to the ongoing job (#64).
 */
export function QuoteCompareScreen() {
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  useProfileFromLink(id);
  // The list's own query: read here only to know whether a job can exist yet.
  const accepted = useRequestQuotes(id).data?.items.some((quote) => quote.status === "accepted");

  return (
    <Screen bar="light" testID="quote-compare-screen">
      <QuoteList
        requestId={id}
        header={
          <View className="gap-6 pb-6 pt-2">
            <BackButton />
            <View className="gap-2">
              <Text accessibilityRole="header" className="text-title-1 text-navy-900">
                {t("quotes.title")}
              </Text>
              <Text className="text-callout text-gray-500">{t("quotes.subtitle")}</Text>
            </View>
            <JobBookedNotice requestId={id} accepted={accepted === true} />
          </View>
        }
      />
    </Screen>
  );
}
