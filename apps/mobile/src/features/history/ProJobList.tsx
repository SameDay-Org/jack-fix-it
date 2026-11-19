import { useScrollToTop } from "expo-router";
import { useMemo, useRef, useState, type ComponentRef, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { FlatList, RefreshControl, View } from "react-native";

import { SessionExpiredError, useSessionGeneration } from "@/api";
import { showToast } from "@/components/ui";
import { RetryNotice } from "@/features/opportunities/RetryNotice";
import {
  flattenProJobs,
  proJobHistoryQueryKey,
  proJobHref,
  useProJobHistory,
} from "@/features/pro-jobs/api";
import type { ProJob } from "@/features/pro-jobs/phase";
import { JobRow, JobRowSkeleton } from "@/features/pro-jobs/YourJobs";
import { useGuardedPush } from "@/features/quotes/navigation";
import { useRefetchOnReturn, useSettledError } from "@/features/quotes/useRequestQuotes";
import { tokens } from "@/theme";

import { HistoryError } from "./HistoryError";
import { useNextPageAfterRefresh } from "./useNextPageAfterRefresh";

export type ProJobListProps = {
  /** Scrolls above the rows and every state: the screen's title. */
  header: ReactElement;
  /** What shows when the pro has no job yet. */
  empty: ReactElement;
  testID?: string;
};

/** About a screen's worth on a small phone. */
const SKELETON_ROWS = 4;
/** How far from the end (in list heights) the next page is asked for. */
const END_REACHED_THRESHOLD = 0.5;

const Gap = () => <View className="h-3" />;

/**
 * The pro's History (#467): every job they were hired for, newest start first as the API orders
 * them, the active ones and the finished, cancelled and reported ones alike, each opening its job
 * screen (where a report is answered). The same states as the customer's list: row-shaped
 * placeholders, a full-screen error with a retry, a next-page error under the rows, the empty
 * state; it loads the next page near the end and refreshes on pull, focus and foreground. A tab
 * root: pressing History again scrolls it to the top.
 */
export function ProJobList({ header, empty, testID = "pro-job-list" }: ProJobListProps) {
  const { t } = useTranslation();
  const generation = useSessionGeneration();
  const queryKey = useMemo(() => proJobHistoryQueryKey(generation), [generation]);
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
  } = useProJobHistory();
  const shownError = useSettledError(data, error);
  useRefetchOnReturn(refetch);
  const push = useGuardedPush();
  const open = (job: ProJob) => push(proJobHref(job.id));
  const [pulling, setPulling] = useState(false);
  const listRef = useRef<ComponentRef<typeof FlatList<ProJob>>>(null);
  useScrollToTop(listRef);
  const nextPage = useNextPageAfterRefresh(queryKey, fetchNextPage);

  const rows = useMemo(() => flattenProJobs(data), [data]);
  // "Today" is counted as of the answer the rows came in: no clock ticks during render.
  const now = dataUpdatedAt;

  // A pull that fails over rows already on screen keeps them and says so; with nothing on screen
  // the error state says it instead.
  const refresh = async () => {
    setPulling(true);
    const result = await refetch();
    setPulling(false);
    if (
      result.isError &&
      result.data !== undefined &&
      !(result.error instanceof SessionExpiredError)
    ) {
      showToast({ message: t("history.pro.refreshFailed"), tone: "danger" });
    }
  };

  const askMore = () => {
    if (hasNextPage) nextPage();
  };
  // After a failed page the retry is the pro's: a stalled server is not asked on every scroll.
  const loadMore = () => {
    if (!isFetchNextPageError) askMore();
  };

  return (
    <FlatList
      ref={listRef}
      testID={testID}
      data={rows}
      keyExtractor={(job) => job.id}
      renderItem={({ item }) => <JobRow job={item} now={now} onPress={open} />}
      ListHeaderComponent={header}
      ListEmptyComponent={
        data !== undefined ? (
          empty
        ) : shownError !== null ? (
          <HistoryError
            title={t("history.pro.error.title")}
            body={t("history.pro.error.body")}
            retry={t("history.pro.error.retry")}
            onRetry={() => void refetch()}
            busy={isFetching}
            testID={`${testID}-error`}
          />
        ) : (
          <ProJobListLoading testID={`${testID}-loading`} />
        )
      }
      ListFooterComponent={
        isFetchingNextPage ? (
          <View className="pt-3">
            <JobRowSkeleton />
          </View>
        ) : isFetchNextPageError ? (
          // The loaded rows stay; the retry asks for the same cursor again.
          <View className="pt-4">
            <RetryNotice
              message={t("history.pro.more.failed")}
              action={t("history.pro.more.retry")}
              onRetry={askMore}
              testID={`${testID}-next-page-error`}
            />
          </View>
        ) : undefined
      }
      onEndReached={loadMore}
      onEndReachedThreshold={END_REACHED_THRESHOLD}
      ItemSeparatorComponent={Gap}
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

/** Row-shaped placeholders, read as one "Loading your jobs" progress indicator. */
function ProJobListLoading({ testID }: { testID: string }) {
  const { t } = useTranslation();
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={t("history.pro.loading")}
      testID={testID}
    >
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        className="gap-3"
      >
        {Array.from({ length: SKELETON_ROWS }, (_, index) => (
          <JobRowSkeleton key={index} />
        ))}
      </View>
    </View>
  );
}
