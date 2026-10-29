import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocalSearchParams } from "expo-router";
import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, Text, useWindowDimensions, View } from "react-native";
import Animated from "react-native-reanimated";

import { CategoryIcon } from "@/components/icons";
import { Button, Screen, TextSkeleton, useSkeletonPulse, VerifiedBadge } from "@/components/ui";
import { BackButton, backToPrevious } from "@/features/auth/components/BackButton";
import { categoryName } from "@/features/home/useCategories";
import { continuousCorners } from "@/theme";

import { useExpiryClock } from "./expiry";
import { formatMoney, formatMonth, formatRating } from "./format";
import { acceptHref, isUuid, useGuardedPush } from "./navigation";
import { displayName, quoteStateOf } from "./quoteText";
import {
  forgetProProfile,
  isDenied,
  isGone,
  useProProfile,
  type ProPublicProfile,
} from "./useProProfile";
import { quotesQueryOptions, useSettledError, type CustomerQuote } from "./useRequestQuotes";

/**
 * The public profile of the pro behind one quote (`/requests/[id]/quotes/[quoteId]/pro`, pushed
 * over the comparison): what a customer may see before payment (#53), and nothing else, as one
 * page rather than a card. The name leads with the verified seal beside it and the month the pro
 * joined under it; then the figures (rating, jobs done, years) as numerals over small labels,
 * or, for a pro with no job done here yet, a plain-spoken note instead; the bio as body text;
 * the categories with their icons; and one line on what verified means. The bar at the bottom
 * holds Accept for the price while the quote is still open in the cached list, and the way back
 * to the quotes. A 404 means the quote left the comparison (expired, withdrawn): the list under
 * this screen is invalidated so its card goes too. A 404 or 403 also drops the profile an earlier
 * answer held (`forgetProProfile`). The skeleton has the loaded rows, so nothing jumps when the
 * profile arrives.
 */
export function ProProfileScreen() {
  const { t } = useTranslation();
  const { id: requestId, quoteId } = useLocalSearchParams<{ id: string; quoteId: string }>();
  const client = useQueryClient();
  // A link can carry anything here: ids that are not ids ask nothing and read as gone.
  const valid = isUuid(requestId) && isUuid(quoteId);
  // Refused (404 or 403) while this screen was up: the profile it held leaves the cache and
  // nothing here asks for it again, so no later failure can bring it back; the next open starts
  // afresh. Read while rendering, so the old profile never shows beside the refusal.
  const key = `${requestId}/${quoteId}`;
  const [denial, setDenial] = useState<{ key: string; status: number } | null>(null);
  const deniedHere = denial?.key === key;
  const profile = useProProfile(requestId, quoteId, valid && !deniedHere);
  const { error, refetch, isFetching } = profile;
  const refused = deniedHere ? denial.status : isDenied(error) ? error.status : null;
  if (refused !== null && !deniedHere) setDenial({ key, status: refused });
  const data = refused === null ? profile.data : undefined;
  const shownError = useSettledError(data, error);
  const gone = !valid || refused === 404 || (data === undefined && isGone(shownError));
  const quote = useOpenQuote(requestId, quoteId);
  const push = useGuardedPush();

  useEffect(() => {
    if (refused !== null) forgetProProfile(client, requestId, quoteId, refused);
  }, [client, quoteId, refused, requestId]);

  return (
    <Screen bar="light" className="bg-white" testID="pro-profile-screen">
      <ScrollView contentContainerClassName="flex-grow px-4 pb-6 pt-2">
        <BackButton />
        {data ? (
          <Profile profile={data} />
        ) : gone ? (
          <ProfileState
            title={t("quotes.profile.gone.title")}
            body={t("quotes.profile.gone.body")}
            action={t("quotes.profile.backToQuotes")}
            onAction={backToPrevious}
            testID="pro-profile-gone"
          />
        ) : shownError ? (
          <ProfileState
            title={t("quotes.profile.error.title")}
            body={t("quotes.error.body")}
            action={t("quotes.error.retry")}
            // After a 403 the screen asks again by enabling the profile it dropped.
            onAction={() => (refused === null ? void refetch() : setDenial(null))}
            busy={isFetching}
            testID="pro-profile-error"
          />
        ) : (
          <ProfileSkeleton />
        )}
      </ScrollView>
      {data ? (
        // Under the scrolling page, so a long bio never hides the way to accept or back.
        <View
          className="gap-2 border-t border-gray-500/15 bg-white px-4 pb-4 pt-3"
          testID="pro-profile-bar"
        >
          {quote ? (
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
          ) : null}
          <Button
            label={t("quotes.profile.backToQuotes")}
            variant="ghost"
            size="lg"
            onPress={backToPrevious}
            testID="pro-profile-back"
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

/** The icon beside a category's name: the glyphs read at 32 and 48, and 24 keeps a tag one line tall. */
const TAG_ICON = 24;
// One recipe for a category tag and its placeholder: a pill with the icon box and the name.
const TAG = "max-w-full flex-row items-center gap-2 rounded-pill py-2 pl-2 pr-3";
const TAG_LABEL = "text-callout font-semibold";
// Running copy (the bio, the new-pro note): the body size with an open line height, as prose reads.
const PROSE = "text-body leading-7";
/** A thin rule between the figures. */
const RULE = "w-px bg-gray-500/15";

type ProfileProps = { profile: ProPublicProfile };

/** The profile as one page, in the order a screen reader should take it. */
function Profile({ profile }: ProfileProps) {
  const { t } = useTranslation();
  const since = formatMonth(profile.member_since);
  const name = displayName(t, profile.name);
  const years =
    profile.years_of_experience === null
      ? null
      : figure(
          profile.years_of_experience,
          t("quotes.profile.stats.years", { count: profile.years_of_experience }),
        );

  return (
    <View className="gap-8 pt-2">
      <View className="gap-1" testID="pro-profile-hero">
        {/* The seal is hidden from screen readers: the header's label says "verified" once. */}
        <Text
          accessibilityRole="header"
          accessibilityLabel={profile.verified ? t("quotes.nameVerified", { name }) : undefined}
          className="text-display text-navy-900"
          testID="pro-profile-name"
        >
          {name}
          {profile.verified ? <VerifiedBadge type="display" testID="pro-profile-verified" /> : null}
        </Text>
        <Text className="text-callout text-gray-500" testID="pro-profile-member-since">
          {t("quotes.profile.memberSince", { month: since })}
        </Text>
      </View>
      {profile.jobs_count > 0 ? (
        <Figures profile={profile} years={years} />
      ) : (
        // No job done here yet: said plainly, with the years when the pro gave them.
        <View className="gap-6">
          <Text className={`${PROSE} text-navy-900`} testID="pro-profile-new">
            {[
              profile.name?.trim()
                ? t("quotes.profile.newPro.named", { name })
                : t("quotes.profile.newPro.unnamed"),
              t("quotes.profile.newPro.joined", { month: since }),
              profile.verified ? t("quotes.profile.newPro.verified") : null,
            ]
              .filter((sentence) => sentence !== null)
              .join(" ")}
          </Text>
          {years ? <FiguresRow cells={[years]} label={years.spoken} /> : null}
        </View>
      )}
      {profile.bio !== null ? (
        <Section title={t("quotes.profile.about")}>
          <Text className={`${PROSE} text-navy-900`} testID="pro-profile-bio">
            {profile.bio}
          </Text>
        </Section>
      ) : null}
      {profile.categories.length > 0 ? (
        <Section title={t("quotes.profile.services")} testID="pro-profile-categories">
          <View className="flex-row flex-wrap gap-2">
            {profile.categories.map((category) => (
              <CategoryTag key={category.id} category={category} />
            ))}
          </View>
        </Section>
      ) : null}
      {profile.verified ? (
        <Text className="text-footnote text-gray-500" testID="pro-profile-trust">
          {t("quotes.profile.trust")}
        </Text>
      ) : null}
    </View>
  );
}

type Figure = {
  /** The numeral, as shown. */
  value: string;
  /** The small label under it, already in the right number. */
  label: string;
  /** The figure as a screen reader says it. */
  spoken: string;
};

/** A count with its label: "23" over "jobs done", read "23 jobs done". */
const figure = (count: number, label: string): Figure => ({
  value: String(count),
  label,
  spoken: `${count} ${label}`,
});

/** The rating with the jobs done, and the years when given: numerals over labels, one row. */
function Figures({ profile, years }: ProfileProps & { years: Figure | null }) {
  const { t } = useTranslation();
  const rating = formatRating(profile.rating_avg);
  const cells = [
    rating === null
      ? { value: "—", label: t("quotes.profile.stats.notRated"), spoken: t("quotes.notRated") }
      : {
          value: `${rating} ★`,
          label: t("quotes.profile.stats.rating"),
          spoken: t("quotes.rated", { rating }),
        },
    figure(profile.jobs_count, t("quotes.profile.stats.jobs", { count: profile.jobs_count })),
    ...(years ? [years] : []),
  ];
  return <FiguresRow cells={cells} label={cells.map((cell) => cell.spoken).join(", ")} />;
}

/**
 * Evenly spaced figures with thin rules between them; read as one sentence. Full-width lines,
 * not fit-content: Android can wrap a one-line text measured to fit by a sub-pixel and hide its
 * tail ("4.8 ★" lost its star at 160 dpi).
 */
function FiguresRow({ cells, label }: { cells: Figure[]; label: string }) {
  return (
    <View accessible accessibilityLabel={label} className="flex-row" testID="pro-profile-figures">
      {cells.map((cell, index) => (
        <Fragment key={cell.label}>
          {index > 0 ? <View className={RULE} /> : null}
          <View className="flex-1 gap-1 px-1">
            <Text className="text-center text-title-1 text-navy-900">{cell.value}</Text>
            {/* A label wider than its cell (Spanish at 1.3 on a narrow phone) breaks at a syllable
                with a hyphen on Android instead of anywhere. */}
            <Text
              android_hyphenationFrequency="normal"
              className="text-center text-caption text-gray-500"
            >
              {cell.label}
            </Text>
          </View>
        </Fragment>
      ))}
    </View>
  );
}

type SectionProps = { title: string; children: ReactNode; testID?: string };

/** A titled part of the page. */
function Section({ title, children, testID }: SectionProps) {
  return (
    <View className="gap-3" testID={testID}>
      <Text accessibilityRole="header" className="text-headline text-navy-900">
        {title}
      </Text>
      {children}
    </View>
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

type ProfileStateProps = {
  title: string;
  body: string;
  action: string;
  onAction: () => void;
  /** The action is under way: its button shows a spinner and ignores taps. */
  busy?: boolean;
  testID: string;
};

/** What happened and what to do next, as the page itself. */
function ProfileState({ title, body, action, onAction, busy, testID }: ProfileStateProps) {
  return (
    <View className="gap-6 pt-2" testID={testID}>
      <View className="gap-2">
        <Text accessibilityRole="header" className="text-title-1 text-navy-900">
          {title}
        </Text>
        <Text className={`${PROSE} text-gray-500`}>{body}</Text>
      </View>
      <Button
        label={action}
        onPress={onAction}
        loading={busy}
        className="self-start"
        testID={`${testID}-action`}
      />
    </View>
  );
}

/** Label widths of the tag placeholders at font scale 1: a short and a long launch category name. */
const TAG_WIDTHS = [64, 120] as const;
/** The placeholders' widths at font scale 1: a name in the display type, a numeral ("4.8 ★"), a label. */
const NAME_WIDTH = 120;
const FIGURE_WIDTH = 56;
const LABEL_WIDTH = 48;
const FIGURES = 3;

/**
 * The page's rows before the profile arrives: every line a `TextSkeleton` of the type that
 * replaces it (the seal sits inside the name's line, so it has no row), three figures, a
 * three-line bio, two tag-shaped pills and a two-line note, so the loaded page takes the same space at any font
 * scale. Read as one "Loading profile" indicator.
 */
function ProfileSkeleton() {
  const { t } = useTranslation();
  const { fontScale } = useWindowDimensions();
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={t("quotes.profile.loading")}
      testID="pro-profile-loading"
    >
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        className="gap-8 pt-2"
      >
        <View className="gap-1">
          <View style={{ width: NAME_WIDTH * fontScale }}>
            <TextSkeleton type="display" />
          </View>
          <TextSkeleton type="callout" width="50%" />
        </View>
        <View className="flex-row">
          {Array.from({ length: FIGURES }, (_, index) => (
            <Fragment key={index}>
              {index > 0 ? <View className={RULE} /> : null}
              <View className="flex-1 items-center gap-1 px-1">
                <View style={{ width: FIGURE_WIDTH * fontScale }}>
                  <TextSkeleton type="title-1" />
                </View>
                <View style={{ width: LABEL_WIDTH * fontScale }}>
                  <TextSkeleton type="caption" />
                </View>
              </View>
            </Fragment>
          ))}
        </View>
        <View className="gap-3">
          <TextSkeleton type="headline" width="25%" />
          {/* One block, no gap: the lines of one wrapped text sit flush. */}
          <View testID="pro-profile-skeleton-bio">
            <TextSkeleton type="body" />
            <TextSkeleton type="body" />
            <TextSkeleton type="body" width="70%" />
          </View>
        </View>
        <View className="gap-3">
          <TextSkeleton type="headline" width="35%" />
          <View className="flex-row flex-wrap gap-2">
            {TAG_WIDTHS.map((width) => (
              <TagSkeleton key={width} labelWidth={width} />
            ))}
          </View>
        </View>
        <View testID="pro-profile-skeleton-trust">
          <TextSkeleton type="footnote" />
          <TextSkeleton type="footnote" width="60%" />
        </View>
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
