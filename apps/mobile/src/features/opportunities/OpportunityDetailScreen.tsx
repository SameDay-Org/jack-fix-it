import { useQueryClient } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, Text, View } from "react-native";

import { Button, Card, IconTile, Screen, Skeleton, TextSkeleton } from "@/components/ui";
import { BackButton } from "@/features/auth/components/BackButton";
import { markOpportunityViewed } from "@/features/pro-home/useOpportunities";
import { useSettledError } from "@/features/quotes/useRequestQuotes";

import { categoryLabel, categoryTileProps, formatDay, locationLabel, sentAgo } from "./format";
import { OpportunityMedia } from "./OpportunityMedia";
import { RetryNotice } from "./RetryNotice";
import { StateCard } from "./StateCard";
import {
  forgetOpportunity,
  isGone,
  mediaExpired,
  useOpportunity,
  useRefreshExpiredMedia,
  type OpportunityDetail,
} from "./useOpportunity";

/** The icon tile's side (`IconTile` md), for the skeleton. */
const TILE_SIDE = 56;
const FACT_ROWS = 3;

/**
 * One opportunity, read-only (`/opportunities/[id]`, where the new-request push lands): the
 * request's code and category, the facts a pro may see before payment (city and ZIP, preferred
 * date, when it was sent), the description, and the photos and videos. Its one action, "Send a
 * quote", stays under the scrolling request and opens the quote form over it.
 */
export function OpportunityDetailScreen() {
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const client = useQueryClient();
  // Answered 404 while this screen was up: its data leaves the cache and nothing here asks for it
  // again, so no later failure can bring the old body back. The next open starts afresh. Adjusted
  // while rendering (state derived from the answer), so not even one more request goes out.
  const [deniedId, setDeniedId] = useState<string | null>(null);
  const denied = deniedId === id;
  const { data, error, refetch, isFetching, dataUpdatedAt } = useOpportunity(id, !denied);
  if (!denied && isGone(error)) setDeniedId(id);
  const shownError = useSettledError(data, error);
  const gone = denied || isGone(shownError);
  // After a denial the hook sees no media, so an expiring URL never asks for the denied id again.
  const now = useRefreshExpiredMedia(denied ? undefined : data?.media, dataUpdatedAt, refetch);
  // A refetch over a loaded request failed: what is on screen stays, and what went missing says so.
  const refreshFailed = !gone && data !== undefined && error !== null;

  // The server marked it viewed on this open: the list behind this screen drops its "New" at once.
  useEffect(() => {
    if (data) markOpportunityViewed(client, data.dispatch_id);
  }, [client, data]);
  // No longer open for this pro: the list stops offering it, and its detail is forgotten.
  useEffect(() => {
    if (denied) void forgetOpportunity(client, id);
  }, [client, denied, id]);

  return (
    <Screen bar="light" testID="opportunity-screen">
      <ScrollView contentContainerClassName="flex-grow px-4 pb-6">
        <View className="pb-6 pt-2">
          <BackButton fallbackHref="/" />
        </View>
        {data === undefined && shownError === null ? (
          <OpportunityDetailSkeleton />
        ) : gone ? (
          <StateCard
            title={t("opportunities.gone.title")}
            body={t("opportunities.gone.body")}
            action={t("opportunities.gone.home")}
            onAction={() => router.dismissTo("/")}
            testID="opportunity-gone"
          />
        ) : data === undefined ? (
          <StateCard
            title={t("opportunities.detailError.title")}
            body={t("opportunities.detailError.body")}
            action={t("opportunities.detailError.retry")}
            onAction={() => void refetch()}
            busy={isFetching}
            testID="opportunity-error"
          />
        ) : (
          <OpportunityBody
            opportunity={data}
            now={now}
            refresh={refreshFailed ? { retry: () => void refetch(), busy: isFetching } : null}
          />
        )}
      </ScrollView>
      {data !== undefined && !gone ? (
        <View className="px-4 pb-4 pt-3">
          <Button
            label={t("opportunities.detail.sendQuote")}
            size="lg"
            onPress={() => router.push({ pathname: "/opportunities/[id]/quote", params: { id } })}
            testID="opportunity-send-quote"
          />
        </View>
      ) : null}
    </Screen>
  );
}

/** A failed refetch of the request, and the way to ask again. */
type Refresh = { retry: () => void; busy: boolean };

type OpportunityBodyProps = {
  opportunity: OpportunityDetail;
  now: number;
  refresh: Refresh | null;
};

function OpportunityBody({ opportunity, now, refresh }: OpportunityBodyProps) {
  const { t } = useTranslation();
  // Expired URLs are never shown; when the refetch that would replace them failed, the notice
  // takes the tiles' place. Fresh tiles and a failure that cost nothing stay as they are.
  const mediaMissing = opportunity.media.some((item) => mediaExpired(item, now));

  return (
    <View className="gap-6" testID="opportunity-body">
      <View className="gap-3">
        <Text className="text-caption text-gray-500" testID="opportunity-code">
          {opportunity.public_code}
        </Text>
        <View className="flex-row items-center gap-3">
          <IconTile {...categoryTileProps(opportunity.category)} />
          <Text
            accessibilityRole="header"
            className="flex-1 text-title-1 text-navy-900"
            testID="opportunity-category"
          >
            {categoryLabel(t, opportunity.category)}
          </Text>
        </View>
      </View>
      <Card className="gap-3" testID="opportunity-facts">
        <Fact
          label={t("opportunities.detail.where")}
          value={locationLabel(opportunity.location)}
          testID="opportunity-location"
        />
        {opportunity.preferred_date ? (
          <Fact
            label={t("opportunities.detail.when")}
            value={formatDay(opportunity.preferred_date)}
            testID="opportunity-date"
          />
        ) : null}
        <Fact
          label={t("opportunities.detail.sent")}
          value={sentAgo(t, opportunity.sent_at, now)}
          testID="opportunity-sent"
        />
      </Card>
      <View className="gap-2">
        <Text accessibilityRole="header" className="text-headline text-navy-900">
          {t("opportunities.detail.description")}
        </Text>
        <Text className="text-body text-navy-900" testID="opportunity-description">
          {opportunity.description}
        </Text>
        {opportunity.text_redacted ? (
          <Text className="text-footnote text-gray-500" testID="opportunity-redacted">
            {t("opportunities.detail.redacted")}
          </Text>
        ) : null}
      </View>
      {refresh && mediaMissing ? (
        <MediaUnavailable refresh={refresh} />
      ) : (
        <OpportunityMedia media={opportunity.media} pending={opportunity.media_pending} now={now} />
      )}
    </View>
  );
}

/** The media section when its fresh URLs could not be fetched: the heading, what happened, a retry. */
function MediaUnavailable({ refresh }: { refresh: Refresh }) {
  const { t } = useTranslation();

  return (
    <View className="gap-3" testID="opportunity-media-unavailable">
      <Text accessibilityRole="header" className="text-headline text-navy-900">
        {t("opportunities.media.title")}
      </Text>
      <RetryNotice
        message={t("opportunities.media.refreshFailed")}
        action={t("opportunities.media.retry")}
        onRetry={refresh.retry}
        busy={refresh.busy}
        testID="opportunity-media-retry"
      />
    </View>
  );
}

type FactProps = {
  label: string;
  value: string;
  testID: string;
};

/** One fact, read as "Where, Fort Lauderdale 33301". */
function Fact({ label, value, testID }: FactProps) {
  return (
    <View accessible className="gap-0.5" testID={testID}>
      <Text className="text-footnote text-gray-500">{label}</Text>
      <Text className="text-callout text-navy-900">{value}</Text>
    </View>
  );
}

/** The loaded layout's rows as placeholders, so nothing jumps when the request arrives. */
function OpportunityDetailSkeleton() {
  const { t } = useTranslation();
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={t("opportunities.detail.loading")}
      testID="opportunity-loading"
    >
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        className="gap-6"
      >
        <View className="gap-3">
          <TextSkeleton type="caption" width="30%" />
          <View className="flex-row items-center gap-3">
            <Skeleton width={TILE_SIDE} height={TILE_SIDE} radius="md" />
            <View className="flex-1">
              <TextSkeleton type="title-1" width="70%" />
            </View>
          </View>
        </View>
        <Card className="gap-3">
          {Array.from({ length: FACT_ROWS }, (_, index) => (
            <View key={index} className="gap-0.5">
              <TextSkeleton type="footnote" width="25%" />
              <TextSkeleton type="callout" width="55%" />
            </View>
          ))}
        </Card>
        <View className="gap-2">
          <TextSkeleton type="headline" width="45%" />
          {/* One block, no gap: the lines of one wrapped text sit flush. */}
          <View>
            <TextSkeleton type="body" />
            <TextSkeleton type="body" />
            <TextSkeleton type="body" width="60%" />
          </View>
        </View>
      </View>
    </View>
  );
}
