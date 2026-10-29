import { router } from "expo-router";
import { useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { FlatList, RefreshControl, View } from "react-native";

import { SessionExpiredError } from "@/api";
import { showToast } from "@/components/ui";
import { tokens } from "@/theme";

import { useExpiryClock } from "./expiry";
import { acceptHref, profileHref, useGuardedPush } from "./navigation";
import { QuoteCard, QuoteCardSkeleton } from "./QuoteCard";
import { quoteStateOf } from "./quoteText";
import { StateCard } from "./StateCard";
import {
  isNotFound,
  useRefetchOnReturn,
  useRequestQuotes,
  useSettledError,
  type CustomerQuote,
} from "./useRequestQuotes";

export type QuoteListProps = {
  requestId: string;
  /** Scrolls above the quotes and every state: the screen's title (later, the request's timeline). */
  header?: ReactElement;
  testID?: string;
};

/** About a screen's worth on a small phone; each one has the loaded card's rows. */
const SKELETON_CARDS = 2;
const NO_QUOTES: CustomerQuote[] = [];

const Separator = () => <View className="h-4" />;

/**
 * The quotes on one request, compared and accepted: one card each in the API's order (never
 * re-sorted), with every state designed (skeletons, empty, not found, error with retry). It is a
 * virtualized list that refreshes on pull, on focus and on foreground; Accept opens the
 * confirmation sheet (`/requests/[id]/accept`) and "View profile" the pro's public profile
 * (`/requests/[id]/quotes/[quoteId]/pro`), one push at a time.
 */
export function QuoteList({ requestId, header, testID = "quote-list" }: QuoteListProps) {
  const { t } = useTranslation();
  const { data, error, refetch, isFetching } = useRequestQuotes(requestId);
  const shownError = useSettledError(data, error);
  const notFound = isNotFound(shownError);
  useRefetchOnReturn(refetch, !notFound);
  const push = useGuardedPush();
  const [pulling, setPulling] = useState(false);

  const items = data && !notFound ? data.items : NO_QUOTES;
  const anyAccepted = items.some((quote) => quote.status === "accepted");
  const pendingExpiries = useMemo(
    () => items.filter((quote) => quote.status === "pending").map((quote) => quote.expires_at),
    [items],
  );
  const now = useExpiryClock(pendingExpiries);

  // A pull that fails over quotes already on screen keeps them and says so; with nothing on
  // screen the error state says it instead.
  const refresh = async () => {
    setPulling(true);
    const result = await refetch();
    setPulling(false);
    const failed = result.isError && result.data !== undefined;
    if (failed && !isNotFound(result.error) && !(result.error instanceof SessionExpiredError)) {
      showToast({ message: t("quotes.refreshFailed"), tone: "danger" });
    }
  };

  return (
    <FlatList
      testID={testID}
      data={items}
      keyExtractor={(quote) => quote.id}
      renderItem={({ item }) => (
        <QuoteCard
          quote={item}
          state={quoteStateOf(item, now, anyAccepted)}
          now={now}
          onAccept={(quote) => push(acceptHref(requestId, quote.id))}
          onViewProfile={(quote) => push(profileHref(requestId, quote.id))}
        />
      )}
      // Rows depend on the clock too: a passing minute or an expiry redraws them.
      extraData={now}
      ListHeaderComponent={header}
      ListEmptyComponent={
        data === undefined && shownError === null ? (
          <QuoteListLoading />
        ) : notFound ? (
          <StateCard
            title={t("quotes.notFound.title")}
            body={t("quotes.notFound.body")}
            action={t("quotes.notFound.home")}
            onAction={() => router.dismissTo("/")}
            testID={`${testID}-not-found`}
          />
        ) : data === undefined ? (
          <StateCard
            title={t("quotes.error.title")}
            body={t("quotes.error.body")}
            action={t("quotes.error.retry")}
            onAction={() => void refetch()}
            busy={isFetching}
            testID={`${testID}-error`}
          />
        ) : (
          <StateCard
            title={t("quotes.empty.title")}
            body={t("quotes.empty.body")}
            testID={`${testID}-empty`}
          />
        )
      }
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

/** Card-shaped placeholders, read as one "Loading quotes" progress indicator. */
function QuoteListLoading() {
  const { t } = useTranslation();
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={t("quotes.loading")}
      testID="quote-list-loading"
    >
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        className="gap-4"
      >
        {Array.from({ length: SKELETON_CARDS }, (_, index) => (
          <QuoteCardSkeleton key={index} testID={`quote-skeleton-${index}`} />
        ))}
      </View>
    </View>
  );
}
