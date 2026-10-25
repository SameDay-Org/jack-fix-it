import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";

import { Button, Card, Chip, ChipSkeleton } from "@/components/ui";
import { startRequest } from "@/features/request";

import { categoryName, useCategories } from "./useCategories";

// Label widths of the loading chips, close to the launch categories' English names, so the
// placeholders break into rows the way the chips will.
const PLACEHOLDER_LABEL_WIDTHS = [124, 80, 68, 164, 152];

/**
 * The secondary way into a request: one chip per category. Loading shows chip-shaped skeletons,
 * a failure says so with a retry, and an empty catalog hides the whole section.
 */
export function CategoryChips() {
  const { t } = useTranslation();
  const categories = useCategories();

  if (categories.data?.length === 0) return null;

  return (
    <View className="gap-4" testID="home-categories">
      <Text accessibilityRole="header" className="text-title-2 text-navy-900">
        {t("home.categoriesTitle")}
      </Text>
      {categories.isPending ? (
        <View
          accessible
          accessibilityRole="progressbar"
          accessibilityLabel={t("home.categoriesLoading")}
          testID="home-categories-loading"
        >
          <View
            importantForAccessibility="no-hide-descendants"
            accessibilityElementsHidden
            className="flex-row flex-wrap gap-3"
          >
            {PLACEHOLDER_LABEL_WIDTHS.map((width, index) => (
              <ChipSkeleton
                key={index}
                labelWidth={width}
                testID={`home-category-skeleton-${index}`}
              />
            ))}
          </View>
        </View>
      ) : categories.isError ? (
        <Card className="gap-4" testID="home-categories-error">
          <Text accessibilityLiveRegion="polite" className="text-body text-navy-900">
            {t("home.categoriesFailed")}
          </Text>
          <Button
            label={t("home.retry")}
            variant="secondary"
            loading={categories.isFetching}
            onPress={() => void categories.refetch()}
            className="self-start"
            testID="home-categories-retry"
          />
        </Card>
      ) : (
        <View className="flex-row flex-wrap gap-3">
          {categories.data.map((category) => (
            <Chip
              key={category.id}
              label={categoryName(category)}
              onPress={() => startRequest(category.slug)}
              testID={`home-category-${category.slug}`}
            />
          ))}
        </View>
      )}
    </View>
  );
}
