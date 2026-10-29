import { useQuery } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AccessibilityInfo, Text, View } from "react-native";

import { Button, SheetContent, VerifiedBadge } from "@/components/ui";

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
  const from = t("quotes.confirm.from", { pro: text.pro });

  // The hook tells the customer how it went; the sheet only closes, or stays to show a failure,
  // said aloud on both platforms (a live region alone is Android-only).
  const onDone = (outcome: AcceptOutcome) => {
    if (outcome === "failed") {
      setFailed(true);
      AccessibilityInfo.announceForAccessibility(t("quotes.confirm.failed"));
    } else if (outcome !== "signedOut") {
      router.back(); // signed out: the session's screens take over
    }
  };

  const confirm = () => {
    setFailed(false);
    accept(quote.id, onDone);
  };

  return (
    <SheetContent
      title={t("quotes.confirm.title")}
      fitToContents
      testID="accept-quote-sheet"
      // In the actions slot, the buttons stay in view when a failure lengthens the body. Full
      // width, one above the other: two pills never squeeze into a row on a narrow phone.
      actions={
        <View className="flex-1 gap-3">
          <Button
            label={t("quotes.confirm.accept")}
            accessibilityLabel={t("quotes.confirm.acceptLabel", {
              pro: text.pro,
              price: text.price,
            })}
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
        </View>
      }
    >
      <View className="gap-1">
        <Text className="text-title-1 text-navy-900">{text.price}</Text>
        {/* The seal is hidden from screen readers, so the line's label says "verified" once. */}
        <Text
          className="text-headline text-navy-900"
          accessibilityLabel={
            quote.pro.verified ? t("quotes.nameVerified", { name: from }) : undefined
          }
          testID="accept-quote-pro"
        >
          {from}
          {quote.pro.verified ? (
            <VerifiedBadge type="headline" testID="accept-quote-verified" />
          ) : null}
        </Text>
        <Text className="text-callout text-gray-500">{text.start}</Text>
        <Text className="text-callout text-gray-500">{text.duration}</Text>
      </View>
      {failed ? (
        <Text className="text-callout text-danger" testID="accept-quote-failed">
          {t("quotes.confirm.failed")}
        </Text>
      ) : null}
    </SheetContent>
  );
}
