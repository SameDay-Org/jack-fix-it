import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";

import { Button, Card, Skeleton, StatusBadge, TextSkeleton } from "@/components/ui";
import { continuousCorners } from "@/theme";

import { useQuoteText, type QuoteState } from "./quoteText";
import { ScopeText } from "./ScopeText";
import type { CustomerQuote } from "./useRequestQuotes";

type QuoteCardProps = {
  quote: CustomerQuote;
  state: QuoteState;
  /** The time the labels are drawn at (see `useExpiryClock`). */
  now: number;
  onAccept: (quote: CustomerQuote) => void;
};

// Shown to sighted users only: the card's summary label already says it.
const VISUAL_ONLY = {
  accessibilityElementsHidden: true,
  importantForAccessibility: "no-hide-descendants",
} as const;

/**
 * One quote as a white bubble. The summary (price, duration, start, the pro) reads as one label;
 * the scope and the Accept button stay separate controls. The price leads because it is what
 * customers compare first; one quote's Accept is a secondary pill, since a list of them shares
 * the screen and the confirmation carries the primary action.
 */
export function QuoteCard({ quote, state, now, onAccept }: QuoteCardProps) {
  const { t } = useTranslation();
  const text = useQuoteText(quote, state, now);
  const testID = `quote-${quote.id}`;

  return (
    <Card testID={testID} className="gap-4">
      <View
        accessible
        accessibilityLabel={text.summary}
        className="gap-3"
        testID={`${testID}-summary`}
      >
        <View className="flex-row items-start justify-between gap-3">
          <View className="shrink gap-1">
            <Text className="text-title-1 text-navy-900">{text.price}</Text>
            <Text className="text-callout text-gray-500">{text.duration}</Text>
            <Text className="text-callout text-gray-500">{text.start}</Text>
          </View>
          {state === "accepted" ? (
            <StatusBadge
              label={t("quotes.accepted")}
              tone="success"
              testID={`${testID}-accepted`}
            />
          ) : null}
        </View>
        <View className="items-start gap-1">
          <Text className="text-headline text-navy-900">{text.pro}</Text>
          {quote.pro.verified ? (
            <StatusBadge label={t("quotes.verified")} tone="brand" testID={`${testID}-verified`} />
          ) : null}
          <Text className="text-footnote text-gray-500">{text.stats}</Text>
        </View>
      </View>
      <ScopeText scope={quote.scope} testID={`${testID}-scope`} />
      <QuoteFooter state={state} expiry={text.expiry} testID={testID}>
        <Button
          label={t("quotes.accept")}
          accessibilityLabel={t("quotes.acceptLabel", { pro: text.pro, price: text.price })}
          variant="secondary"
          onPress={() => onAccept(quote)}
          testID={`${testID}-accept`}
        />
      </QuoteFooter>
    </Card>
  );
}

type QuoteFooterProps = {
  state: QuoteState;
  expiry: string;
  /** The Accept button, shown only while the quote is open. */
  children: ReactNode;
  testID: string;
};

/** What the customer can do with the quote now: accept it before it expires, or nothing more. */
function QuoteFooter({ state, expiry, children, testID }: QuoteFooterProps) {
  const { t } = useTranslation();

  if (state === "accepted") {
    return (
      <View {...VISUAL_ONLY} style={continuousCorners} className="rounded-md bg-green-500/10 p-3">
        <Text className="text-callout text-navy-900" testID={`${testID}-accepted-note`}>
          {t("quotes.acceptedNote")}
        </Text>
      </View>
    );
  }
  if (state === "expired") {
    return (
      <View {...VISUAL_ONLY}>
        <StatusBadge label={expiry} tone="neutral" testID={`${testID}-expired`} />
      </View>
    );
  }
  return (
    <View className="min-h-12 flex-row flex-wrap items-center justify-between gap-3">
      <Text
        {...VISUAL_ONLY}
        className="shrink text-footnote text-gray-500"
        testID={`${testID}-expiry`}
      >
        {expiry}
      </Text>
      {state === "open" ? children : null}
    </View>
  );
}

/** Pill-shaped like the Accept button: the kit's medium size (min-h-12) and about its width. */
const ACCEPT_PLACEHOLDER = { width: 96, height: 48 } as const;

/**
 * A card-shaped placeholder with the loaded card's rows: every line is a `TextSkeleton` of the
 * same type style, so each row is exactly as tall as the text that replaces it, at any font
 * scale. The verified badge has its row too (the list only shows quotes from approved pros, so
 * every listed card has one), padded like the badge. A typical scope takes two lines here.
 */
export function QuoteCardSkeleton({ testID }: { testID?: string }) {
  return (
    <Card testID={testID} className="gap-4">
      <View className="gap-3">
        <View className="gap-1">
          <TextSkeleton type="title-1" width="35%" />
          <TextSkeleton type="callout" width="30%" />
          <TextSkeleton type="callout" width="75%" />
        </View>
        <View className="gap-1">
          <TextSkeleton type="headline" width="40%" />
          <View className="w-1/2 py-1" testID={testID && `${testID}-badge`}>
            <TextSkeleton type="caption" />
          </View>
          <TextSkeleton type="footnote" width="70%" />
        </View>
      </View>
      <View style={continuousCorners} className="gap-1 rounded-md bg-gray-50 p-3">
        <TextSkeleton type="caption" width="35%" />
        <TextSkeleton type="callout" />
        <TextSkeleton type="callout" width="60%" />
      </View>
      <View className="min-h-12 flex-row items-center justify-between gap-3">
        <View className="shrink grow">
          <TextSkeleton type="footnote" width="60%" />
        </View>
        <Skeleton {...ACCEPT_PLACEHOLDER} radius="pill" />
      </View>
    </Card>
  );
}
