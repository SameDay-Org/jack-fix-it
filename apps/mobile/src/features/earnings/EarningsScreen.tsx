import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { FlatList, RefreshControl, Text, View } from "react-native";

import { SessionExpiredError } from "@/api";
import { Button, Notice, Screen, showToast } from "@/components/ui";
import { BackButton } from "@/features/auth/components/BackButton";
import { RetryNotice } from "@/features/opportunities/RetryNotice";
import { StateCard } from "@/features/opportunities/StateCard";
import { PAYOUTS_HREF } from "@/features/payouts/links";
import { useMyProProfile } from "@/features/pro-profile";
import { useGuardedPush } from "@/features/quotes/navigation";
import { useRefetchOnReturn, useSettledError } from "@/features/quotes/useRequestQuotes";
import { tokens } from "@/theme";

import {
  earningsFailure,
  earningsSummary,
  flattenEarnings,
  useEarnings,
  useRefreshFirstPage,
} from "./api";
import { EarningRow, EarningRowSkeleton } from "./EarningRow";
import { EarningsSummary } from "./EarningsSummary";

const HOME = "/";
/** About a screen's worth of rows under the summary on a small phone. */
const SKELETON_ROWS = 2;
/** How far from the end (in list heights) the next page is asked for. */
const END_REACHED_THRESHOLD = 0.5;

const Separator = () => <View className="h-3" />;

/**
 * The pro's earnings (#70), pushed from the home's wallet card: the API's totals over all the
 * pro's jobs, then each finished job, newest first, a page per cursor as the pro nears the end.
 * A pull (at the top of the list) asks for the first page alone; focus and foreground ask again
 * for the rows on screen. A pro whose payouts are not on is pointed to the setup
 * first. Every state is designed: skeletons, empty, offline, too many tries, an error with a retry,
 * and a next page that failed under the rows already loaded.
 */
export function EarningsScreen() {
  const { t } = useTranslation();
  const query = useEarnings();
  const { data, error, refetch, isFetching, dataUpdatedAt } = query;
  const { fetchNextPage, hasNextPage, isFetchingNextPage, isFetchNextPageError } = query;
  const refreshFirstPage = useRefreshFirstPage();
  const shownError = useSettledError(data, error);
  useRefetchOnReturn(refetch);
  const [pulling, setPulling] = useState(false);
  const items = useMemo(() => flattenEarnings(data), [data]);
  const summary = earningsSummary(data);

  // A pull that fails over rows already on screen keeps them and says why in a toast; with
  // nothing on screen the error state says it instead.
  const refresh = async () => {
    const shown = data !== undefined;
    setPulling(true);
    try {
      await refreshFirstPage();
    } catch (failed) {
      if (shown && !(failed instanceof SessionExpiredError)) {
        showToast({
          message: t(`earnings.refreshFailed.${earningsFailure(failed)}`),
          tone: "danger",
        });
      }
    } finally {
      setPulling(false);
    }
  };

  // Nearing the end asks for the next page once. Not while a refresh is under way: the next page
  // would cancel it and grow from the old rows. After a failed page the retry is the pro's.
  const loadMore = () => {
    if (hasNextPage && !isFetching && !isFetchNextPageError) void fetchNextPage();
  };

  const failure = earningsFailure(shownError);
  const noJobs = data !== undefined && items.length === 0;
  const header = (
    <View className="gap-6 pb-6 pt-2">
      <View className="gap-2">
        <BackButton fallbackHref={HOME} />
        <Text accessibilityRole="header" className="text-title-1 text-navy-900">
          {t("earnings.title")}
        </Text>
      </View>
      <PayoutNudge />
      {/* No totals over a failure, nor before any finished job: they would all read $0.00. */}
      {(data === undefined && shownError !== null) || noJobs ? null : (
        <EarningsSummary summary={summary} />
      )}
      {items.length > 0 ? (
        <Text accessibilityRole="header" className="text-headline text-navy-900">
          {t("earnings.jobs")}
        </Text>
      ) : null}
    </View>
  );

  return (
    <Screen bar="light" testID="earnings-screen">
      <FlatList
        testID="earnings-list"
        data={items}
        keyExtractor={(item) => item.job_id}
        // Rows only come with a page, and every page carries the summary and its currency.
        renderItem={({ item }) =>
          summary ? (
            <EarningRow item={item} currency={summary.currency} now={dataUpdatedAt} />
          ) : null
        }
        ListHeaderComponent={header}
        ListEmptyComponent={
          data === undefined && shownError === null ? (
            <View
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              className="gap-3"
              testID="earnings-rows-loading"
            >
              {Array.from({ length: SKELETON_ROWS }, (_, index) => (
                <EarningRowSkeleton key={index} />
              ))}
            </View>
          ) : data === undefined ? (
            <StateCard
              title={t(`earnings.failure.${failure}.title`)}
              body={t(`earnings.failure.${failure}.body`)}
              action={t("earnings.retry")}
              onAction={() => void refetch()}
              busy={isFetching}
              testID={`earnings-error-${failure}`}
            />
          ) : (
            <StateCard
              title={t("earnings.empty.title")}
              body={t("earnings.empty.body")}
              testID="earnings-empty"
            />
          )
        }
        ListFooterComponent={
          isFetchingNextPage ? (
            <View
              accessible
              accessibilityRole="progressbar"
              accessibilityLabel={t("earnings.loading")}
              className="pt-3"
              testID="earnings-next-page"
            >
              <EarningRowSkeleton />
            </View>
          ) : isFetchNextPageError ? (
            // The loaded rows stay; the retry asks for the same cursor again.
            <View className="pt-4">
              <RetryNotice
                message={t("earnings.more.failed")}
                action={t("earnings.retry")}
                onRetry={() => void fetchNextPage()}
                testID="earnings-next-page-error"
              />
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
    </Screen>
  );
}

/**
 * "Set up payouts to get paid", while the pro's payouts are not on: the profile says so (the payout
 * screen keeps it in step with Stripe; this screen never asks Stripe itself). Nothing while the
 * profile is unknown.
 */
function PayoutNudge() {
  const { t } = useTranslation();
  const push = useGuardedPush();
  const { data: profile } = useMyProProfile();
  if (profile === undefined || profile.payouts_enabled) return null;
  return (
    <Notice
      tone="info"
      title={t("earnings.payouts.title")}
      body={t("earnings.payouts.body")}
      testID="earnings-payouts"
    >
      <Button
        label={t("earnings.payouts.action")}
        variant="secondary"
        onPress={() => push(PAYOUTS_HREF)}
        testID="earnings-payouts-action"
      />
    </Notice>
  );
}
