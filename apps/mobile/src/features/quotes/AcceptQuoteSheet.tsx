import { useQuery } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AccessibilityInfo, Text, View } from "react-native";

import { Button, SheetContent, showToast, StatusBadge } from "@/components/ui";

import { useAcceptQuote, type AcceptOutcome } from "./useAcceptQuote";
import { quotesQueryOptions } from "./useRequestQuotes";
import { quoteText } from "./quoteText";

/**
 * The confirmation before accepting a quote (`/requests/[id]/accept?quote=…`, a fit-to-contents
 * sheet over the list). It restates the price and the pro as they were when Accept was tapped,
 * then posts once; the answer decides the rest:
 * - accepted: the sheet closes over the accepted card, and screen readers hear it;
 * - no longer acceptable (409, 404): the sheet closes, a toast says so, the list refetches;
 * - offline or a server error: the sheet stays with the reason, and confirming again is safe.
 */
export function AcceptQuoteSheet() {
  const { t } = useTranslation();
  const { id: requestId, quote: quoteId } = useLocalSearchParams<{ id: string; quote: string }>();
  // Read from the list on screen, never fetched here; kept as first shown, so a refetch while the
  // sheet is up cannot change what the customer is confirming.
  const { data } = useQuery({ ...quotesQueryOptions(requestId), enabled: false });
  const [quote] = useState(() => data?.items.find((item) => item.id === quoteId));
  const [now] = useState(Date.now);
  const { accept, sending } = useAcceptQuote(requestId);
  const [failed, setFailed] = useState(false);

  // Opened without its quote on screen (a stale link): there is nothing to confirm.
  useEffect(() => {
    if (!quote) router.back();
  }, [quote]);

  if (!quote) return null;
  const text = quoteText(t, quote, "open", now);

  const onDone = (outcome: AcceptOutcome) => {
    if (outcome === "failed") {
      setFailed(true);
      return;
    }
    if (outcome === "signedOut") return; // the session's own screens take over
    router.back();
    if (outcome === "accepted") {
      AccessibilityInfo.announceForAccessibility(t("quotes.acceptedNote"));
    } else {
      showToast({ message: t("quotes.notAcceptable"), tone: "danger" });
    }
  };

  const confirm = () => {
    setFailed(false);
    accept(quote.id, onDone);
  };

  return (
    <SheetContent title={t("quotes.confirm.title")} fitToContents testID="accept-quote-sheet">
      <View className="gap-1">
        <Text className="text-title-1 text-navy-900">{text.price}</Text>
        <Text className="text-headline text-navy-900">
          {t("quotes.confirm.from", { pro: text.pro })}
        </Text>
        {quote.pro.verified ? <StatusBadge label={t("quotes.verified")} tone="brand" /> : null}
        <Text className="text-callout text-gray-500">{text.start}</Text>
        <Text className="text-callout text-gray-500">{text.duration}</Text>
      </View>
      {failed ? (
        <Text
          accessibilityLiveRegion="polite"
          className="text-callout text-danger"
          testID="accept-quote-failed"
        >
          {t("quotes.confirm.failed")}
        </Text>
      ) : null}
      {/* Full-width, one above the other: two pills never squeeze into a row on a narrow phone. */}
      <Button
        label={t("quotes.confirm.accept")}
        accessibilityLabel={t("quotes.acceptLabel", { pro: text.pro, price: text.price })}
        size="lg"
        loading={sending}
        onPress={confirm}
        testID="accept-quote-confirm"
      />
      <Button
        label={t("quotes.confirm.notNow")}
        variant="ghost"
        size="lg"
        disabled={sending}
        onPress={() => router.back()}
        testID="accept-quote-cancel"
      />
    </SheetContent>
  );
}
