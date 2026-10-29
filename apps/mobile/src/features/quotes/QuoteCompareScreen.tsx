import { useLocalSearchParams } from "expo-router";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";

import { Screen } from "@/components/ui";
import { BackButton } from "@/features/auth/components/BackButton";

import { useProfileFromLink } from "./links";
import { QuoteList } from "./QuoteList";

/**
 * The customer's quotes on one request (`/requests/[id]`, where the new-quote push lands): a
 * title and one supporting line, then the quote list, which scrolls them along. A link to a pro's
 * profile lands here and opens the profile over the list (`useProfileFromLink`).
 */
export function QuoteCompareScreen() {
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  useProfileFromLink(id);

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
          </View>
        }
      />
    </Screen>
  );
}
