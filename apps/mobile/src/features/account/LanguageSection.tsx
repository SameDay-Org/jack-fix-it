import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";

import { sessionGeneration, type SessionUser } from "@/api";
import { Button, ListGroup, ListRow, Notice } from "@/components/ui";
import { activeLanguage, LANGUAGES, setLanguage, type Language } from "@/i18n";

import { useLocaleSaving, useSaveLocale } from "./api";

/**
 * The app's language (#218): one row per language, each named in itself, the one on screen
 * checked. Choosing one puts the whole app in it at once, then saves it to the account, which is
 * where the next launch, the next sign-in and the server read it from.
 *
 * The device never waits for the save and never goes back on it: while the account still holds
 * another language than the one on screen (the save failed, or there is no connection), a notice
 * says so and offers to send it again.
 */
export function LanguageSection({ user }: { user: SessionUser }) {
  // Subscribes to the language: this section renders again in the one just chosen.
  const { t } = useTranslation();
  const language = activeLanguage();
  const save = useSaveLocale();
  const saving = useLocaleSaving();
  // A retry keeps the notice up, with its button busy; a first save is silent until it fails.
  const [retrying, setRetrying] = useState(false);
  const unsaved = user.locale !== language;

  const choose = (next: Language) => {
    if (next === language) return;
    setLanguage(next);
    save.mutate({ locale: next, generation: sessionGeneration() });
  };
  const retry = () => {
    setRetrying(true);
    save.mutate(
      { locale: language, generation: sessionGeneration() },
      { onSettled: () => setRetrying(false) },
    );
  };

  return (
    <View className="gap-3">
      <Text className="text-footnote font-semibold uppercase text-gray-500">
        {t("settings.sections.language")}
      </Text>
      <ListGroup
        accessibilityRole="radiogroup"
        accessibilityLabel={t("settings.sections.language")}
        testID="settings-language"
      >
        {LANGUAGES.map((option) => (
          <ListRow
            key={option}
            label={t(`settings.language.${option}`)}
            selected={option === language}
            accessibilityLanguage={option}
            onPress={() => choose(option)}
            testID={`settings-language-${option}`}
          />
        ))}
      </ListGroup>
      {unsaved && (!saving || retrying) ? (
        <Notice
          tone="info"
          title={t("settings.language.unsaved.title")}
          body={t("settings.language.unsaved.body")}
          testID="settings-language-unsaved"
        >
          <Button
            label={t("settings.language.unsaved.retry")}
            variant="secondary"
            loading={saving}
            onPress={retry}
            testID="settings-language-retry"
          />
        </Notice>
      ) : null}
    </View>
  );
}
