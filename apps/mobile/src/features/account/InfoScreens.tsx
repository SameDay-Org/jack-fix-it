import { useTranslation } from "react-i18next";
import { ScrollView, Text } from "react-native";

import { Screen } from "@/components/ui";
import { BackButton } from "@/features/auth/components/BackButton";

/*
 * Legal (#293) has no content yet: the final Terms and Privacy Policy are not ready (#97). The
 * screen says so plainly, offers nothing that does not work, and keeps its row's promise of a
 * screen. The texts replace the lines, not the route, when they land. Help is `help/HelpScreen`.
 */

/** Legal: a document's page, left-aligned like the texts it will hold. */
export function LegalScreen() {
  const { t } = useTranslation();
  return (
    <Screen bar="light" testID="legal-screen">
      <ScrollView contentContainerClassName="gap-4 px-4 pb-6 pt-2">
        <BackButton fallbackHref="/account" />
        <Text accessibilityRole="header" className="text-title-1 text-navy-900">
          {t("legal.title")}
        </Text>
        <Text className="text-body text-navy-900">{t("legal.lead")}</Text>
        <Text className="text-callout text-gray-500">{t("legal.body")}</Text>
      </ScrollView>
    </Screen>
  );
}
