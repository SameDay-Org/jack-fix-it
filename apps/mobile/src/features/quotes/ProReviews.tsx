import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";

import { ApiError } from "@/api";
import { Button, TextSkeleton } from "@/components/ui";
import { RetryNotice } from "@/features/opportunities/RetryNotice";

import { formatLocale } from "./format";
import { useProReviews, type PublicReview } from "./useProReviews";

/** The most stars a review gives. */
const MAX_STARS = 5;
/** Placeholder rows while the first page loads. */
const SKELETON_ROWS = 2;
const CALENDAR_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The day a review was written, with its year ("Nov 12, 2026"): reviews span years. */
export function formatReviewDay(day: string, locale: string = formatLocale()): string {
  const match = CALENDAR_DAY.exec(day);
  if (!match) return day;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

/**
 * The pro's published reviews on their profile (#78): a few at first, newest first, then more
 * on request (the API's cursor). Each is its stars, who wrote it and when, and their words. No
 * review yet says so; a read that failed says so with a retry and leaves the rest of the profile
 * as it is. A pro the API no longer shows (404) shows no section: the profile above says enough.
 */
export function ProReviews({ proId }: { proId: string }) {
  const { t } = useTranslation();
  const reviews = useProReviews(proId);
  const { data, error, isFetching, isFetchingNextPage, hasNextPage } = reviews;
  if (error instanceof ApiError && error.status === 404) return null;
  const items = data?.pages.flatMap((page) => page.items) ?? [];
  // A page after the first that failed: the reviews shown stay, with a retry of that page.
  const moreFailed = data !== undefined && reviews.isFetchNextPageError;

  let body;
  if (data === undefined && error === null) {
    body = <ReviewsSkeleton />;
  } else if (data === undefined) {
    body = (
      <RetryNotice
        message={t("quotes.profile.reviews.failed")}
        action={t("quotes.error.retry")}
        onRetry={() => void reviews.refetch()}
        busy={isFetching}
        testID="pro-profile-reviews-failed"
      />
    );
  } else if (items.length === 0) {
    body = (
      <Text className="text-callout text-gray-500" testID="pro-profile-reviews-empty">
        {t("quotes.profile.reviews.empty")}
      </Text>
    );
  } else {
    body = (
      <View className="gap-6">
        {items.map((review, index) => (
          // Reviews carry no id (none is public): their place in the list is stable, newest first.
          <ReviewRow key={`${review.created_on}-${index}`} review={review} />
        ))}
        {moreFailed ? (
          <RetryNotice
            message={t("quotes.profile.reviews.moreFailed")}
            action={t("quotes.error.retry")}
            onRetry={() => void reviews.fetchNextPage()}
            busy={isFetchingNextPage}
            testID="pro-profile-reviews-more-failed"
          />
        ) : hasNextPage ? (
          <View className="flex-row">
            <Button
              label={t("quotes.profile.reviews.more")}
              accessibilityLabel={t("quotes.profile.reviews.moreLabel")}
              variant="secondary"
              loading={isFetchingNextPage}
              onPress={() => void reviews.fetchNextPage()}
              testID="pro-profile-reviews-more"
            />
          </View>
        ) : null}
      </View>
    );
  }

  return (
    <View className="gap-3" testID="pro-profile-reviews">
      <Text accessibilityRole="header" className="text-headline text-navy-900">
        {t("quotes.profile.reviews.title")}
      </Text>
      {body}
    </View>
  );
}

/** The reviewer as the API names them, or a plain stand-in when it names nobody. */
const reviewerOf = (t: TFunction, review: PublicReview): string =>
  review.reviewer?.trim() || t("quotes.profile.reviews.anonymous");

/**
 * One review: its stars, who wrote it and when, then their words. Read as one sentence: "María
 * P., 5 out of 5, Nov 12, 2026. Great work."
 */
function ReviewRow({ review }: { review: PublicReview }) {
  const { t } = useTranslation();
  const who = reviewerOf(t, review);
  const day = formatReviewDay(review.created_on);
  const spoken = t("quotes.profile.reviews.label", { reviewer: who, rating: review.rating, day });
  return (
    <View
      accessible
      accessibilityLabel={review.comment ? `${spoken}. ${review.comment}` : spoken}
      className="gap-1"
      testID="pro-profile-review"
    >
      <Text className="text-callout" testID="pro-profile-review-stars">
        <Text className="text-navy-900">{"★".repeat(review.rating)}</Text>
        <Text className="text-gray-500/40">{"★".repeat(MAX_STARS - review.rating)}</Text>
      </Text>
      <Text className="text-footnote text-gray-500">{`${who} · ${day}`}</Text>
      {review.comment ? (
        <Text className="text-body leading-7 text-navy-900">{review.comment}</Text>
      ) : null}
    </View>
  );
}

function ReviewsSkeleton() {
  const { t } = useTranslation();
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={t("quotes.profile.reviews.loading")}
      className="gap-6"
      testID="pro-profile-reviews-loading"
    >
      {Array.from({ length: SKELETON_ROWS }, (_, row) => (
        <View key={row} className="gap-1">
          <TextSkeleton type="callout" width="30%" />
          <TextSkeleton type="footnote" width="45%" />
          <TextSkeleton type="body" width="85%" />
        </View>
      ))}
    </View>
  );
}
