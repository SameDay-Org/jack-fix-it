import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocalSearchParams } from "expo-router";
import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, Text, useWindowDimensions, View } from "react-native";
import Animated from "react-native-reanimated";

import { CategoryIcon } from "@/components/icons";
import { Button, Card, Screen, StatusBadge, TextSkeleton, useSkeletonPulse } from "@/components/ui";
import { BackButton, backToPrevious } from "@/features/auth/components/BackButton";
import { categoryName } from "@/features/home/useCategories";
import { continuousCorners } from "@/theme";

import { useExpiryClock } from "./expiry";
import { formatMoney, formatMonth, formatRating, joinFacts } from "./format";
import { acceptHref, useGuardedPush } from "./navigation";
import { displayName, quoteStateOf } from "./quoteText";
import { StateCard } from "./StateCard";
import { isGone, useProProfile, type ProPublicProfile } from "./useProProfile";
import {
  quotesQueryKey,
  quotesQueryOptions,
  useSettledError,
  type CustomerQuote,
} from "./useRequestQuotes";

/**
 * The public profile of the pro behind one quote (`/requests/[id]/quotes/[quoteId]/pro`, pushed
 * over the comparison): what a customer may see before payment (#53), and nothing else. The name
 * or the neutral label, the verified badge, the rating with the jobs done (or "New"), the years
 * of experience, the bio (contacts masked by the API), the categories and the month the pro
 * joined. While the quote is still open in the cached list, Accept opens the same confirmation
 * as the card. A 404 means the quote left the comparison (expired, withdrawn): the list under
 * this screen is invalidated so its card goes too. The skeleton has the loaded rows, so nothing
 * jumps when the profile arrives.
 */
export function ProProfileScreen() {
  const { t } = useTranslation();
  const { id: requestId, quoteId } = useLocalSearchParams<{ id: string; quoteId: string }>();
  const { data, error, refetch, isFetching } = useProProfile(requestId, quoteId);
  const shownError = useSettledError(data, error);
  const gone = data === undefined && isGone(shownError);
  const quote = useOpenQuote(requestId, quoteId);
  const push = useGuardedPush();
  useInvalidateQuotes(requestId, gone);

  return (
    <Screen bar="light" testID="pro-profile-screen">
      <ScrollView contentContainerClassName="flex-grow gap-6 px-4 pb-6 pt-2">
        <BackButton />
        {data ? (
          <Profile profile={data} />
        ) : gone ? (
          <StateCard
            title={t("quotes.profile.gone.title")}
            body={t("quotes.profile.gone.body")}
            action={t("quotes.profile.gone.back")}
            onAction={backToPrevious}
            testID="pro-profile-gone"
          />
        ) : shownError ? (
          <StateCard
            title={t("quotes.profile.error.title")}
            body={t("quotes.error.body")}
            action={t("quotes.error.retry")}
            onAction={() => void refetch()}
            busy={isFetching}
            testID="pro-profile-error"
          />
        ) : (
          <ProfileSkeleton />
        )}
      </ScrollView>
      {data && quote ? (
        // Below the scrolling profile, so a long bio never hides the way to accept.
        <View className="px-4 pb-4 pt-2">
          <Button
            label={t("quotes.profile.accept", { price: formatMoney(quote.amount_cents) })}
            accessibilityLabel={t("quotes.acceptLabel", {
              pro: displayName(t, data.name),
              price: formatMoney(quote.amount_cents),
            })}
            size="lg"
            onPress={() => push(acceptHref(requestId, quote.id))}
            testID="pro-profile-accept"
          />
        </View>
      ) : null}
    </Screen>
  );
}

/**
 * The quote from the cached comparison list while it is still open to accept; null once it is
 * accepted, expired (on the server or on screen), closed by another acceptance, or not on the
 * list this screen came from. Read, never fetched: the list under this screen owns it.
 */
function useOpenQuote(requestId: string, quoteId: string): CustomerQuote | null {
  const { data } = useQuery({ ...quotesQueryOptions(requestId), enabled: false });
  const quote = data?.items.find((item) => item.id === quoteId);
  const anyAccepted = data?.items.some((item) => item.status === "accepted") ?? false;
  const expiries = useMemo(() => (quote?.status === "pending" ? [quote.expires_at] : []), [quote]);
  const now = useExpiryClock(expiries);
  return quote && quoteStateOf(quote, now, anyAccepted) === "open" ? quote : null;
}

/** A 404 says the quote left the comparison: the list under this screen is told, so its card goes too. */
function useInvalidateQuotes(requestId: string, gone: boolean): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (gone) void queryClient.invalidateQueries({ queryKey: quotesQueryKey(requestId) });
  }, [gone, queryClient, requestId]);
}

/** The icon beside a category's name: the glyphs read at 32 and 48, and 24 keeps a tag one line tall. */
const TAG_ICON = 24;

// One recipe for a category tag and its placeholder: a pill with the icon box and the name.
const TAG = "max-w-full flex-row items-center gap-2 rounded-pill py-2 pl-2 pr-3";
const TAG_LABEL = "text-callout font-semibold";

type ProfileProps = { profile: ProPublicProfile };

/** The profile in one bubble, in the order a screen reader should take it. */
function Profile({ profile }: ProfileProps) {
  const { t } = useTranslation();
  const rating = formatRating(profile.rating_avg);
  const jobs = t("quotes.jobs", { count: profile.jobs_count });
  // "★ 4.8 · 23 jobs" once there is a rating and a job; "New on Jack Fix It" before either.
  const track =
    rating !== null && profile.jobs_count > 0
      ? {
          text: joinFacts([`★ ${rating}`, jobs]),
          label: `${t("quotes.rated", { rating })}, ${jobs}`,
        }
      : { text: t("quotes.profile.new"), label: undefined };
  const years =
    profile.years_of_experience === null
      ? null
      : t("quotes.years", { count: profile.years_of_experience });

  return (
    <Card className="gap-5" testID="pro-profile">
      <View className="gap-2">
        <Text
          accessibilityRole="header"
          className="text-title-1 text-navy-900"
          testID="pro-profile-name"
        >
          {displayName(t, profile.name)}
        </Text>
        {profile.verified ? (
          <StatusBadge label={t("quotes.verified")} tone="brand" testID="pro-profile-verified" />
        ) : null}
      </View>
      <View className="gap-1">
        <Text
          accessibilityLabel={track.label}
          className="text-headline text-navy-900"
          testID="pro-profile-track"
        >
          {track.text}
        </Text>
        {years !== null ? (
          <Text className="text-callout text-gray-500" testID="pro-profile-years">
            {years}
          </Text>
        ) : null}
      </View>
      {profile.bio !== null ? (
        <View
          style={continuousCorners}
          className="gap-1 rounded-md bg-gray-50 p-3"
          testID="pro-profile-bio"
        >
          <Text accessibilityRole="header" className="text-caption text-gray-500">
            {t("quotes.profile.about")}
          </Text>
          <Text className="text-callout text-navy-900">{profile.bio}</Text>
        </View>
      ) : null}
      {profile.categories.length > 0 ? (
        <View className="gap-2" testID="pro-profile-categories">
          <Text accessibilityRole="header" className="text-caption text-gray-500">
            {t("quotes.profile.services")}
          </Text>
          <View className="flex-row flex-wrap gap-2">
            {profile.categories.map((category) => (
              <CategoryTag key={category.id} category={category} />
            ))}
          </View>
        </View>
      ) : null}
      <Text className="text-footnote text-gray-500" testID="pro-profile-member-since">
        {t("quotes.profile.memberSince", { month: formatMonth(profile.member_since) })}
      </Text>
    </Card>
  );
}

type CategoryTagProps = { category: ProPublicProfile["categories"][number] };

/** One category as a pill: its icon (decorative) beside its name in the app's language. */
function CategoryTag({ category }: CategoryTagProps) {
  const name = categoryName(category);
  return (
    <View
      accessible
      accessibilityLabel={name}
      style={continuousCorners}
      className={`${TAG} bg-green-500/10`}
      testID={`pro-profile-category-${category.slug}`}
    >
      <CategoryIcon slug={category.slug} size={TAG_ICON} fallback />
      <Text className={`shrink ${TAG_LABEL} text-navy-900`}>{name}</Text>
    </View>
  );
}

/** Label widths of the tag placeholders at font scale 1: a short and a long launch category name. */
const TAG_WIDTHS = [64, 120] as const;

/**
 * The profile's rows before it arrives: every line a `TextSkeleton` of the type that replaces it
 * (the badge's row padded like the badge), a three-line bio block, two tag-shaped pills and the
 * member line, so the loaded bubble takes the same space at any font scale. Read as one
 * "Loading profile" indicator.
 */
function ProfileSkeleton() {
  const { t } = useTranslation();
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={t("quotes.profile.loading")}
      testID="pro-profile-loading"
    >
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <Card className="gap-5">
          <View className="gap-2">
            <TextSkeleton type="title-1" width="55%" />
            <View className="w-1/2 py-1" testID="pro-profile-skeleton-badge">
              <TextSkeleton type="caption" />
            </View>
          </View>
          <View className="gap-1">
            <TextSkeleton type="headline" width="45%" />
            <TextSkeleton type="callout" width="55%" />
          </View>
          <View
            style={continuousCorners}
            className="gap-1 rounded-md bg-gray-50 p-3"
            testID="pro-profile-skeleton-bio"
          >
            <TextSkeleton type="caption" width="25%" />
            {/* One block, no gap: the lines of one wrapped text sit flush. */}
            <View>
              <TextSkeleton type="callout" />
              <TextSkeleton type="callout" />
              <TextSkeleton type="callout" width="70%" />
            </View>
          </View>
          <View className="gap-2">
            <TextSkeleton type="caption" width="30%" />
            <View className="flex-row flex-wrap gap-2">
              {TAG_WIDTHS.map((width) => (
                <TagSkeleton key={width} labelWidth={width} />
              ))}
            </View>
          </View>
          <TextSkeleton type="footnote" width="50%" />
        </Card>
      </View>
    </View>
  );
}

/**
 * A tag-shaped placeholder: the tag's padding and icon box around an invisible label of the
 * tag's type, so it is exactly as tall as a tag at any font scale.
 */
function TagSkeleton({ labelWidth }: { labelWidth: number }) {
  const pulse = useSkeletonPulse();
  const { fontScale } = useWindowDimensions();
  return (
    <Animated.View style={pulse}>
      <View style={continuousCorners} className={`${TAG} bg-gray-500/15`}>
        <View style={{ width: TAG_ICON, height: TAG_ICON }} />
        <Text className={`${TAG_LABEL} text-transparent`} style={{ width: labelWidth * fontScale }}>
          {" "}
        </Text>
      </View>
    </Animated.View>
  );
}
