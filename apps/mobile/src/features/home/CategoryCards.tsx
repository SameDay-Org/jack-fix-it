import { useCallback, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Text, useWindowDimensions, View, type LayoutChangeEvent } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button, Card } from "@/components/ui";
import { startRequest } from "@/features/request";
import { continuousCorners } from "@/theme";

import {
  CARD_COLUMNS,
  CARD_GAP,
  CategoryCard,
  CategoryCardSkeleton,
  cardSide,
} from "./CategoryCard";
import { categoryName, useCategories } from "./useCategories";

// The panel's side inset (px-4). A style, not a class, because the grid's first frame derives its
// row width from the window minus this inset until `onLayout` reports the measured row.
const PANEL_PADDING = 16;

// Placeholders shown while the catalog loads: the launch catalog's size, not a business value.
const SKELETON_COUNT = 5;

/** `items` in rows of `size`, in order; the last row holds the remainder. */
function chunk<T>(items: readonly T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    rows.push(items.slice(start, start + size));
  }
  return rows;
}

/**
 * The width the grid's rows get, measured, with the window minus the panel inset as the first
 * frame's value so the cards paint at their size at once (on a phone the two agree, and a
 * measurement that differs re-renders the grid once).
 */
function useRowWidth(): [number, (event: LayoutChangeEvent) => void] {
  const { width: windowWidth } = useWindowDimensions();
  const [measured, setMeasured] = useState<number | null>(null);
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    setMeasured(event.nativeEvent.layout.width);
  }, []);
  return [measured ?? windowWidth - 2 * PANEL_PADDING, onLayout];
}

type GridProps = {
  /** Keyed cells, in order; CARD_COLUMNS per row, a short last row aligned to the start. */
  cells: ReactNode[];
  onLayout: (event: LayoutChangeEvent) => void;
  testID: string;
};

/** Rows of fixed-width cells; cells in a row stretch to the tallest one, so a long name grows its whole row. */
function Grid({ cells, onLayout, testID }: GridProps) {
  return (
    <View onLayout={onLayout} style={{ rowGap: CARD_GAP }} testID={testID}>
      {chunk(cells, CARD_COLUMNS).map((row, index) => (
        <View
          key={index}
          className="flex-row"
          style={{ columnGap: CARD_GAP }}
          testID={`${testID}-row-${index}`}
        >
          {row}
        </View>
      ))}
    </View>
  );
}

/**
 * The way into a request (#232): a grid of square category cards, two per row. Loading shows
 * card-shaped skeletons in the same cells, a failure says so with a retry (which shows the
 * skeletons again: a query with no data goes back to pending), and an empty catalog hides the
 * whole section, panel included: the hero then fills the page instead of sitting over a blank
 * sheet.
 *
 * The light panel runs to the bottom edge and pads the home indicator itself (the screen's own
 * bottom padding would be the navy page).
 */
export function CategoryCards() {
  const { t } = useTranslation();
  const { bottom } = useSafeAreaInsets();
  const categories = useCategories();
  const [rowWidth, onGridLayout] = useRowWidth();
  const side = cardSide(rowWidth);

  if (categories.data?.length === 0) return null;

  return (
    <View
      style={[continuousCorners, { paddingBottom: bottom }]}
      className="flex-grow rounded-t-xl bg-gray-50"
      testID="home-categories"
    >
      <View style={{ paddingHorizontal: PANEL_PADDING }} className="gap-4 pb-6 pt-6">
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
            <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
              <Grid
                onLayout={onGridLayout}
                testID="home-categories-skeleton-grid"
                cells={Array.from({ length: SKELETON_COUNT }, (_, index) => (
                  <CategoryCardSkeleton
                    key={index}
                    side={side}
                    testID={`home-category-skeleton-${index}`}
                  />
                ))}
              />
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
          <Grid
            onLayout={onGridLayout}
            testID="home-categories-grid"
            cells={categories.data.map((category) => (
              <CategoryCard
                key={category.id}
                slug={category.slug}
                name={categoryName(category)}
                side={side}
                onPress={() => startRequest(category.slug)}
                testID={`home-category-${category.slug}`}
              />
            ))}
          />
        )}
      </View>
    </View>
  );
}
