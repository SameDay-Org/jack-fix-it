import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";

import { Screen, StatusBadge } from "@/components/ui";
import { BackButton } from "@/features/auth/components/BackButton";
import { categoryName, useCategories } from "@/features/home/useCategories";

import { useDraftCategorySlug } from "./requestDraft";

/**
 * Where a new request starts. A placeholder until the request flow lands (#45): the title, and
 * the category picked on home by its localized name. Only a direct link to the route, with no
 * start on home before it, arrives without a draft: then the title alone.
 */
export function RequestStartPlaceholderScreen() {
  const { t } = useTranslation();
  const slug = useDraftCategorySlug();
  const { data: categories } = useCategories();
  const category = slug ? categories?.find((candidate) => candidate.slug === slug) : undefined;

  return (
    <Screen bar="light" testID="request-start">
      <View className="flex-1 gap-4 px-4 pb-4 pt-2">
        <View className="gap-2">
          <BackButton />
          <Text accessibilityRole="header" className="text-title-1 text-navy-900">
            {t("request.title")}
          </Text>
        </View>
        {category ? (
          <StatusBadge label={categoryName(category)} tone="info" testID="request-start-category" />
        ) : null}
      </View>
    </Screen>
  );
}
