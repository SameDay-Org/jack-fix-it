import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import Animated from "react-native-reanimated";

import { ACCOUNT_GLYPHS } from "@/components/icons";
import { AccordionRow, IconTile, ListGroup, Screen, useAccordion } from "@/components/ui";
import { BackButton } from "@/features/auth/components/BackButton";

import { FAQ, FAQ_SECTIONS, faqIn } from "./faq";

const FAQ_ORDER = FAQ.map((item) => item.id);

/**
 * Help (#274, part 1): the FAQ, grouped by the moment a question comes up. A question opens in
 * place, one at a time, so its neighbors stay in view and nothing navigates; the content is
 * `faq.ts` and the catalogs, never this file.
 */
export function HelpScreen() {
  const { t } = useTranslation();
  const accordion = useAccordion(FAQ_ORDER);

  return (
    <Screen bar="light" testID="help-screen">
      <Animated.ScrollView {...accordion.scroll}>
        <View className="gap-8 px-4 pb-6 pt-2">
          <View className="gap-3">
            <BackButton fallbackHref="/account" />
            <IconTile slug="" glyph={ACCOUNT_GLYPHS.help} size="md" />
            <View className="gap-2">
              <Text accessibilityRole="header" className="text-title-1 text-navy-900">
                {t("help.title")}
              </Text>
              <Text className="text-body text-gray-500">{t("help.intro")}</Text>
            </View>
          </View>
          {FAQ_SECTIONS.map((section) => (
            <View key={section} className="gap-3">
              <Text accessibilityRole="header" className="text-title-2 text-navy-900">
                {t(`help.sections.${section}`)}
              </Text>
              <ListGroup testID={`help-${section}`}>
                {faqIn(section).map(({ id, question, answer }) => (
                  <AccordionRow
                    key={id}
                    title={t(question)}
                    testID={`help-${id}`}
                    {...accordion.row(id)}
                  >
                    <Text android_hyphenationFrequency="full" className="text-body text-gray-500">
                      {t(answer)}
                    </Text>
                  </AccordionRow>
                ))}
              </ListGroup>
            </View>
          ))}
          {/* Part 2 of #274 adds the "Still need help?" block here, under the last section, once
              the support tickets API is in @jack/shared. Nothing stands in for it until then. */}
        </View>
      </Animated.ScrollView>
    </Screen>
  );
}
