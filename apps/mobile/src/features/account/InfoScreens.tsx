import { useTranslation } from "react-i18next";
import { ScrollView, Text, View } from "react-native";

import { ACCOUNT_GLYPHS } from "@/components/icons";
import { IconTile, Screen } from "@/components/ui";
import { BackButton } from "@/features/auth/components/BackButton";

/*
 * Help and Legal (#293) have no content yet: support channels and the final Terms and Privacy
 * Policy are not ready. Each screen says so plainly, offers nothing that does not work, and keeps
 * its row's promise of a screen. They replace the text, not the routes, when the content lands.
 */

/** Help: a centered mark and one honest line, the start of a support page. */
export function HelpScreen() {
  const { t } = useTranslation();
  return (
    <Screen bar="light" testID="help-screen">
      <View className="flex-1 px-4 pt-2">
        <BackButton fallbackHref="/account" />
        <View className="flex-1 items-center justify-center gap-4 pb-16">
          <IconTile slug="" glyph={ACCOUNT_GLYPHS.help} size="lg" />
          <Text accessibilityRole="header" className="text-center text-title-2 text-navy-900">
            {t("help.title")}
          </Text>
          <Text className="max-w-xs text-center text-body text-gray-500">{t("help.body")}</Text>
        </View>
      </View>
    </Screen>
  );
}

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
