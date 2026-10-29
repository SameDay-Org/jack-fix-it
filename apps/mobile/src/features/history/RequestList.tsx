import { useQueryClient } from "@tanstack/react-query";
import { router, unstable_useIsNavigating, useScrollToTop } from "expo-router";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentRef,
  type ReactElement,
} from "react";
import { useTranslation } from "react-i18next";
import { FlatList, RefreshControl, Text, View } from "react-native";

import { SessionExpiredError } from "@/api";
import { Button, showToast } from "@/components/ui";
import { useCategories } from "@/features/home/useCategories";
import { RetryNotice } from "@/features/opportunities/RetryNotice";
import { useRefetchOnReturn, useSettledError } from "@/features/quotes/useRequestQuotes";
import { tokens } from "@/theme";

import { RequestRow, RequestRowSeparator, RequestRowSkeleton } from "./RequestRow";
import {
  flattenMyRequests,
  MY_REQUESTS_QUERY_KEY,
  useMyRequests,
  type RequestSummary,
} from "./useMyRequests";

export type RequestListProps = {
  /** Scrolls above the rows and every state: the screen's title. */
  header: ReactElement;
  /** What shows when the customer has sent no request yet. */
  empty: ReactElement;
  testID?: string;
};

/** About a screen's worth on a small phone. */
const SKELETON_ROWS = 6;
/** How far from the end (in list heights) the next page is asked for. */
const END_REACHED_THRESHOLD = 0.5;

/**
 * The customer's requests, newest first as the API orders them, with every state designed
 * (skeleton rows, empty, a full-screen error with a retry, a next-page error under the rows). A
 * virtualized list that loads the next page as the customer nears the end and refreshes on pull,
 * on focus and on foreground; a row opens its request. Rows wait for the category catalog too,
 * since a row names its category: a catalog that fails shows the same error, unless there are
 * no rows to name (the empty state shows). A tab root: pressing History again scrolls it to the top.
 */
export function RequestList({ header, empty, testID = "request-list" }: RequestListProps) {
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
    isFetchNextPageError,
  } = useMyRequests();
  const categories = useCategories();
  const shownError = useSettledError(data, error);
  const categoriesError = useSettledError(categories.data, categories.error);
  useRefetchOnReturn(refetch);
  const open = useOpenRequest();
  const [pulling, setPulling] = useState(false);
  const listRef = useRef<ComponentRef<typeof FlatList<RequestSummary>>>(null);
  useScrollToTop(listRef);
  const nextPage = useNextPageAfterRefresh(fetchNextPage);

  const rows = useMemo(() => flattenMyRequests(data), [data]);
  // Rows name their category, so they wait for the catalog; with no rows there is nothing to name.
  const ready = data !== undefined && (categories.data !== undefined || rows.length === 0);
  const failed = !ready && (shownError !== null || categoriesError !== null);
  const items = ready ? rows : [];
  // "Today" is counted as of the answer the rows came in: every refetch moves it on, and no
  // clock ticks during render.
  const now = dataUpdatedAt;

  // A first-page retry asks again for whatever is missing: the list, the catalog or both.
  const retry = () => {
    if (data === undefined) void refetch();
    if (categories.data === undefined) void categories.refetch();
  };

  // A pull that fails over rows already on screen keeps them and says so; with nothing on screen
  // the error state says it instead. A catalog that never loaded is asked for again too.
  const refresh = async () => {
    setPulling(true);
    if (categories.data === undefined) void categories.refetch();
    const result = await refetch();
    setPulling(false);
    const refreshFailed = result.isError && result.data !== undefined;
    if (refreshFailed && !(result.error instanceof SessionExpiredError)) {
      showToast({ message: t("history.customer.refreshFailed"), tone: "danger" });
    }
  };

  // The next page, or its retry; never one that cancels a refresh.
  const askMore = () => {
    if (hasNextPage) nextPage();
  };

  // Nearing the end asks for the next page once; after a failed page the footer says so and the
  // retry is the customer's, so a stalled server is not asked again on every scroll.
  const loadMore = () => {
    if (!isFetchNextPageError) askMore();
  };

  return (
    <FlatList
      ref={listRef}
      testID={testID}
      data={items}
      keyExtractor={(request) => request.id}
      renderItem={({ item }) => (
        <RequestRow request={item} categories={categories.data ?? []} now={now} onPress={open} />
      )}
      ListHeaderComponent={header}
      ListEmptyComponent={
        failed ? (
          <RequestListError
            onRetry={retry}
            busy={isFetching || categories.isFetching}
            testID={`${testID}-error`}
          />
        ) : ready ? (
          empty
        ) : (
          <RequestListLoading testID={`${testID}-loading`} />
        )
      }
      ListFooterComponent={
        isFetchingNextPage ? (
          <>
            <RequestRowSeparator />
            <RequestRowSkeleton testID={`${testID}-next-page`} />
          </>
        ) : isFetchNextPageError ? (
          // The loaded rows stay; the retry asks for the same cursor again.
          <View className="px-4 pt-4">
            <RetryNotice
              message={t("history.customer.more.failed")}
              action={t("history.customer.more.retry")}
              onRetry={askMore}
              testID={`${testID}-next-page-error`}
            />
          </View>
        ) : undefined
      }
      onEndReached={loadMore}
      onEndReachedThreshold={END_REACHED_THRESHOLD}
      ItemSeparatorComponent={RequestRowSeparator}
      contentContainerClassName="flex-grow pb-6"
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
 * Asks for the next page without ever cancelling a refresh of the list (focus, pull, an
 * invalidation): TanStack would drop the refresh and the old statuses would stay on screen. A page
 * asked for during a refresh is fetched once the refresh settles. The query is read directly,
 * since a refresh that just started may not have rendered yet.
 */
function useNextPageAfterRefresh(
  fetchNextPage: (options: { cancelRefetch: boolean }) => Promise<unknown>,
): () => void {
  const client = useQueryClient();
  const waiting = useRef<(() => void) | null>(null);
  useEffect(() => () => waiting.current?.(), []);

  return useCallback(() => {
    const cache = client.getQueryCache();
    const query = cache.find({ queryKey: MY_REQUESTS_QUERY_KEY, exact: true });
    const fetch = () => void fetchNextPage({ cancelRefetch: false });
    if (query?.state.fetchStatus !== "fetching") return fetch();
    // A page on its way already, or one waiting for the refresh: nothing more to ask.
    if (query.state.fetchMeta?.fetchMore || waiting.current) return;
    const stop = cache.subscribe((event) => {
      if (event.query !== query) return;
      const removed = event.type === "removed";
      if (!removed && query.state.fetchStatus === "fetching") return;
      stop();
      waiting.current = null;
      if (!removed) fetch();
    });
    waiting.current = stop;
  }, [client, fetchNextPage]);
}

/**
 * Opens a request. A second tap before it is up opens nothing: the router queues a push and the
 * list stays tappable until it lands. Once the router is idle again a row opens again.
 */
function useOpenRequest() {
  const opening = useRef(false);
  const navigating = unstable_useIsNavigating();

  useEffect(() => {
    if (!navigating) opening.current = false;
  }, [navigating]);

  return useCallback((request: RequestSummary) => {
    if (opening.current) return;
    opening.current = true;
    router.push({ pathname: "/requests/[id]", params: { id: request.id } });
  }, []);
}

/** Row-shaped placeholders, read as one "Loading your requests" progress indicator. */
function RequestListLoading({ testID }: { testID: string }) {
  const { t } = useTranslation();
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={t("history.customer.loading")}
      testID={testID}
    >
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        {Array.from({ length: SKELETON_ROWS }, (_, index) => (
          <View key={index}>
            {index > 0 ? <RequestRowSeparator /> : null}
            <RequestRowSkeleton testID={`request-skeleton-${index}`} />
          </View>
        ))}
      </View>
    </View>
  );
}

type RequestListErrorProps = { onRetry: () => void; busy: boolean; testID: string };

/** Nothing to show and the first page failed: the whole screen says so, with the one way out. */
function RequestListError({ onRetry, busy, testID }: RequestListErrorProps) {
  const { t } = useTranslation();
  return (
    <View className="flex-1 items-center justify-center gap-6 px-4 pb-12" testID={testID}>
      <View className="items-center gap-2">
        <Text accessibilityRole="header" className="text-center text-title-2 text-navy-900">
          {t("history.customer.error.title")}
        </Text>
        <Text className="text-center text-body text-gray-500">
          {t("history.customer.error.body")}
        </Text>
      </View>
      <Button
        label={t("history.customer.error.retry")}
        onPress={onRetry}
        loading={busy}
        testID={`${testID}-action`}
      />
    </View>
  );
}
