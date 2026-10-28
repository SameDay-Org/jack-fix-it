import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button, Card, Chip, ChipSkeleton } from "@/components/ui";
import { deviceLocale } from "@/features/auth/locale";
import { startRequest } from "@/features/request";
import { continuousCorners } from "@/theme";

import { categoryName, useCategories } from "./useCategories";

// Label widths of the loading chips, in dp at font scale 1, per language the chips render in:
// they follow the seeded catalog (the 5 launch categories, in the API's order) as measured on the
// Android emulator, so the placeholders break into rows the way the chips will. Update them with
// the seed.
const PLACEHOLDER_LABEL_WIDTHS: Record<ReturnType<typeof deviceLocale>, readonly number[]> = {
  en: [83, 121, 158, 152, 64],
  es: [183, 145, 177, 159, 55],
};

/**
 * The secondary way into a request: one chip per category. Loading shows chip-shaped skeletons,
 * a failure says so with a retry (which shows the skeletons again: a query with no data goes back
 * to pending), and an empty catalog hides the whole section, panel included: the hero then fills
 * the page instead of sitting over a blank sheet.
 *
 * The light panel runs to the bottom edge and pads the home indicator itself (the screen's own
 * bottom padding would be the navy page).
 */
export function CategoryChips() {
  const { t } = useTranslation();
  const { bottom } = useSafeAreaInsets();
  const categories = useCategories();

  if (categories.data?.length === 0) return null;

  return (
    <View
      style={[continuousCorners, { paddingBottom: bottom }]}
      className="flex-grow rounded-t-xl bg-gray-50"
      testID="home-categories"
    >
      <View className="gap-4 px-4 pb-6 pt-6">
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
              {PLACEHOLDER_LABEL_WIDTHS[deviceLocale()].map((width, index) => (
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
    </View>
  );
}
