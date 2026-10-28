import { router, unstable_useIsNavigating } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { FlatList, RefreshControl, Text, View } from "react-native";

import { SessionExpiredError } from "@/api";
import { Button, Card, showToast } from "@/components/ui";
import { tokens } from "@/theme";

import { useExpiryClock } from "./expiry";
import { QuoteCard, QuoteCardSkeleton } from "./QuoteCard";
import { quoteStateOf } from "./quoteText";
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
 * confirmation sheet (`/requests/[id]/accept`).
 */
export function QuoteList({ requestId, header, testID = "quote-list" }: QuoteListProps) {
  const { t } = useTranslation();
  const { data, error, refetch, isFetching } = useRequestQuotes(requestId);
  const shownError = useSettledError(data, error);
  const notFound = isNotFound(shownError);
  useRefetchOnReturn(refetch, !notFound);
  const openAccept = useOpenAccept(requestId);
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
          onAccept={openAccept}
        />
      )}
      // Rows depend on the clock too: a passing minute or an expiry redraws them.
      extraData={now}
      ListHeaderComponent={header}
      ListEmptyComponent={
        data === undefined && shownError === null ? (
          <QuoteListLoading />
        ) : notFound ? (
          <QuoteListMessage
            title={t("quotes.notFound.title")}
            body={t("quotes.notFound.body")}
            action={t("quotes.notFound.home")}
            onAction={() => router.dismissTo("/")}
            testID={`${testID}-not-found`}
          />
        ) : data === undefined ? (
          <QuoteListMessage
            title={t("quotes.error.title")}
            body={t("quotes.error.body")}
            action={t("quotes.error.retry")}
            onAction={() => void refetch()}
            busy={isFetching}
            testID={`${testID}-error`}
          />
        ) : (
          <QuoteListMessage
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

/**
 * Opens the confirmation for a quote. A second tap before the sheet is up opens nothing: the
 * router queues a push and the list stays tappable until it lands. Once the router is idle again
 * (the sheet is up, or the push came to nothing) Accept works again.
 */
function useOpenAccept(requestId: string) {
  const opening = useRef(false);
  const navigating = unstable_useIsNavigating();

  useEffect(() => {
    if (!navigating) opening.current = false;
  }, [navigating]);

  return useCallback(
    (quote: CustomerQuote) => {
      if (opening.current) return;
      opening.current = true;
      router.push({
        pathname: "/requests/[id]/accept",
        params: { id: requestId, quote: quote.id },
      });
    },
    [requestId],
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

type QuoteListMessageProps = {
  title: string;
  body: string;
  /** The one thing to do next, when there is one. */
  action?: string;
  onAction?: () => void;
  /** The action is under way: its button shows a spinner and ignores taps. */
  busy?: boolean;
  testID: string;
};

/** A state in a bubble: what happened, and what to do next. */
function QuoteListMessage({ title, body, action, onAction, busy, testID }: QuoteListMessageProps) {
  return (
    <Card testID={testID} className="gap-4">
      <View className="gap-1">
        <Text accessibilityRole="header" className="text-headline text-navy-900">
          {title}
        </Text>
        <Text className="text-callout text-gray-500">{body}</Text>
      </View>
      {action && onAction ? (
        <Button label={action} onPress={onAction} loading={busy} testID={`${testID}-action`} />
      ) : null}
    </Card>
  );
}
