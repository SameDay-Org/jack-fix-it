import { router, unstable_useIsNavigating } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { FlatList, RefreshControl, View } from "react-native";

import { SessionExpiredError } from "@/api";
import { showToast } from "@/components/ui";
import { StateCard } from "@/features/opportunities/StateCard";
import { useRefetchOnReturn, useSettledError } from "@/features/quotes/useRequestQuotes";
import { tokens } from "@/theme";

import { OpportunityCard, OpportunityCardSkeleton } from "./OpportunityCard";
import {
  flattenOpportunities,
  useOpportunities,
  type OpportunitySummary,
} from "./useOpportunities";

export type OpportunityListProps = {
  /** Scrolls above the cards and every state: the home's greeting and the section title. */
  header?: ReactElement;
  testID?: string;
};

/** About a screen's worth on a small phone; each one has the loaded card's rows. */
const SKELETON_CARDS = 3;
/** How far from the end (in list heights) the next page is asked for. */
const END_REACHED_THRESHOLD = 0.5;

const Separator = () => <View className="h-4" />;

/**
 * The pro's open opportunities, newest first as the API orders them, with every state designed
 * (skeletons, empty, error with retry). A virtualized list that loads the next page as the pro
 * nears the end and refreshes on pull, on focus and on foreground; a card opens its detail.
 */
export function OpportunityList({ header, testID = "opportunity-list" }: OpportunityListProps) {
  const { t } = useTranslation();
  const {
    data,
    dataUpdatedAt,
    error,
    refetch,
    isFetching,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useOpportunities();
  const shownError = useSettledError(data, error);
  useRefetchOnReturn(refetch);
  const open = useOpenOpportunity();
  const [pulling, setPulling] = useState(false);

  const items = useMemo(() => flattenOpportunities(data), [data]);
  // "Sent … ago" is drawn as of the answer it came in: every refetch (pull, focus, foreground)
  // moves it on, and no clock ticks during render.
  const now = dataUpdatedAt;

  // A pull that fails over cards already on screen keeps them and says so; with nothing on
  // screen the error state says it instead.
  const refresh = async () => {
    setPulling(true);
    const result = await refetch();
    setPulling(false);
    const failed = result.isError && result.data !== undefined;
    if (failed && !(result.error instanceof SessionExpiredError)) {
      showToast({ message: t("opportunities.refreshFailed"), tone: "danger" });
    }
  };

  const loadMore = () => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  };

  return (
    <FlatList
      testID={testID}
      data={items}
      keyExtractor={(opportunity) => opportunity.dispatch_id}
      renderItem={({ item }) => <OpportunityCard opportunity={item} now={now} onPress={open} />}
      ListHeaderComponent={header}
      ListEmptyComponent={
        data === undefined && shownError === null ? (
          <OpportunityListLoading />
        ) : data === undefined ? (
          <StateCard
            title={t("opportunities.error.title")}
            body={t("opportunities.error.body")}
            action={t("opportunities.error.retry")}
            onAction={() => void refetch()}
            busy={isFetching}
            testID={`${testID}-error`}
          />
        ) : (
          <StateCard
            title={t("opportunities.empty.title")}
            body={t("opportunities.empty.body")}
            testID={`${testID}-empty`}
          />
        )
      }
      ListFooterComponent={
        isFetchingNextPage ? (
          <View className="pt-4">
            <OpportunityCardSkeleton testID={`${testID}-next-page`} />
          </View>
        ) : undefined
      }
      onEndReached={loadMore}
      onEndReachedThreshold={END_REACHED_THRESHOLD}
      ItemSeparatorComponent={Separator}
      contentContainerClassName="flex-grow px-4 pb-6"
      refreshControl={
        <RefreshControl
          refreshing={pulling}
          onRefresh={() => void refresh()}
          tintColor={tokens.colors["navy-900"]}
          colors={[tokens.colors["navy-900"]]}
        />
      }
    />
  );
}

/**
 * Opens an opportunity's detail. A second tap before it is up opens nothing: the router queues
 * a push and the list stays tappable until it lands. Once the router is idle again (the detail
 * is up, or the push came to nothing) a card opens again.
 */
function useOpenOpportunity() {
  const opening = useRef(false);
  const navigating = unstable_useIsNavigating();

  useEffect(() => {
    if (!navigating) opening.current = false;
  }, [navigating]);

  return useCallback((opportunity: OpportunitySummary) => {
    if (opening.current) return;
    opening.current = true;
    router.push({ pathname: "/opportunities/[id]", params: { id: opportunity.dispatch_id } });
  }, []);
}

/** Card-shaped placeholders, read as one "Loading opportunities" progress indicator. */
function OpportunityListLoading() {
  const { t } = useTranslation();
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={t("opportunities.loading")}
      testID="opportunity-list-loading"
    >
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        className="gap-4"
      >
        {Array.from({ length: SKELETON_CARDS }, (_, index) => (
          <OpportunityCardSkeleton key={index} testID={`opportunity-skeleton-${index}`} />
        ))}
      </View>
    </View>
  );
}
