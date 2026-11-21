import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { router, unstable_useIsNavigating, useIsFocused, useScrollToTop } from "expo-router";
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
import { FlatList, RefreshControl, View } from "react-native";

import { isCurrentGeneration, SessionExpiredError, useSessionGeneration } from "@/api";
import { showToast } from "@/components/ui";
import { useCategories } from "@/features/home/useCategories";
import { customerJobQueryOptions, jobHref } from "@/features/jobs/api";
import { RetryNotice } from "@/features/opportunities/RetryNotice";
import { useRefetchOnReturn, useSettledError } from "@/features/quotes/useRequestQuotes";
import { tokens } from "@/theme";

import { HistoryError } from "./HistoryError";
import { RequestRow, RequestRowSeparator, RequestRowSkeleton } from "./RequestRow";
import { useNextPageAfterRefresh } from "./useNextPageAfterRefresh";
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
  const nextPage = useNextPageAfterRefresh(MY_REQUESTS_QUERY_KEY, fetchNextPage);

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
          <HistoryError
            title={t("history.customer.error.title")}
            body={t("history.customer.error.body")}
            retry={t("history.customer.error.retry")}
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
 * Opens a request. A second tap before it is up opens nothing: the router queues a push and the
 * list stays tappable until it lands. Once the router is idle again a row opens again.
 *
 * A cancelled request whose job was booked opens on that job (#545): the cancel, where its money
 * stands and, after a pro's cancel, the way to a new request are there. Its quotes are not: the
 * API lists none once a request is cancelled. The job the app already holds opens at once (the
 * customer who just cancelled on the job screen); otherwise it is asked first, with the job
 * screen's own query, so the screen opens with it. With none (cancelled before anyone was hired)
 * or no answer, the request opens as any other. While that answer is on its way the list stays
 * live: a newer tap wins over it, and it opens nothing once History is no longer in front (the
 * customer went to another tab) or the session that asked is over.
 */
function useOpenRequest() {
  const client = useQueryClient();
  const generation = useSessionGeneration();
  // Read when the answer comes, not when the tap came in.
  const focused = useIsFocused();
  const inFront = useRef(focused);
  useEffect(() => {
    inFront.current = focused;
  }, [focused]);
  // A push is under way (the router queues it): no second one.
  const opening = useRef(false);
  // The newest tap: one still waiting for its job opens nothing once another came in.
  const latest = useRef(0);
  const navigating = unstable_useIsNavigating();

  useEffect(() => {
    if (!navigating) opening.current = false;
  }, [navigating]);

  const open = useCallback(
    async (request: RequestSummary) => {
      if (opening.current) return;
      const tap = ++latest.current;
      const booked =
        request.status === "cancelled" && (await hasJob(client, request.id, generation));
      const wanted =
        tap === latest.current &&
        inFront.current &&
        !opening.current &&
        isCurrentGeneration(generation);
      if (!wanted) return;
      opening.current = true;
      router.push(
        booked ? jobHref(request.id) : { pathname: "/requests/[id]", params: { id: request.id } },
      );
    },
    [client, generation],
  );
  return useCallback((request: RequestSummary) => void open(request), [open]);
}

/**
 * Whether the request's job answers: the one the app already holds (whatever its age: the job
 * screen reads it again as it opens), else asked now; false on a 404 or no answer.
 */
async function hasJob(client: QueryClient, requestId: string, generation: number) {
  try {
    await client.ensureQueryData(customerJobQueryOptions(requestId, generation));
    return true;
  } catch {
    return false;
  }
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
