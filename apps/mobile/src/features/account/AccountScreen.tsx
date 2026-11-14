import { useIsFocused, useScrollToTop } from "expo-router";
import { useEffect, useRef, useState, type ComponentRef } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import Animated from "react-native-reanimated";

import { apiConfig, useSession, type SessionUser } from "@/api";
import { ControlIcon } from "@/components/icons";
import {
  Button,
  IdCard,
  IdCardShareRender,
  moveAccessibilityFocus,
  placeOf,
  Screen,
  TextSkeleton,
  useTabBarInset,
  type IdCardShareHandle,
} from "@/components/ui";
import { cx } from "@/components/ui/cx";
import { formatMonth } from "@/features/quotes/format";
// The stat alone: the rest of reviews (its drafts) loads with the rating screen.
import { useRatingStat, type RatingStat } from "@/features/reviews/ratingStat";
import { pressedTransform, tokens } from "@/theme";

import { useFreshPhoto } from "./api";
import { AccountMenu } from "./AccountMenu";
import { cardDetails } from "./identity";
import { useCardFocus } from "./useCardFocus";
import { useShareIdCard } from "./useShareIdCard";

/** The page's side margin (`px-4`), which the card's width leaves on both sides. */
const GUTTER = 16;
/** On a wide screen the card stops growing: an ID card is held, not spread across a tablet. */
const MAX_CARD_WIDTH = 420;
/** Kept free under the centered card for the gesture hint, above the tab bar. */
const HINT_ROOM = 56;
/** Above this font scale the header has no room for "Compartir" beside the title. */
const COMPACT_SHARE_SCALE = 1.3;
/** The star before the average: the size of the headline's capitals, not following the font. */
const STAT_STAR = 18;

/**
 * The Account tab (#293), the same for a customer and a pro: the ID card on top, then how long the
 * person has been a member and their rating, then a short list (Settings, Help, Legal, Log out).
 * The card is a button: it takes the stage (focus mode), centered and alive (tilt, flip), while the
 * rest moves away; Back, the Android back gesture or the Account tab restores the page. Share, in
 * the header in both modes, sends a still image of the card without the phone.
 */
export function AccountScreen() {
  const { user } = useSession();
  // Tabs stay mounted while another one shows: only the focused tab owns the status bar.
  const focused = useIsFocused();
  if (!user) return null;
  return <AccountContent user={user} focused={focused} />;
}

function AccountContent({ user, focused }: { user: SessionUser; focused: boolean }) {
  const { t } = useTranslation();
  const inset = useTabBarInset();
  const { width: windowWidth, fontScale } = useWindowDimensions();
  const cardWidth = Math.min(windowWidth - GUTTER * 2, MAX_CARD_WIDTH);
  // Share turns into its glyph when the title would not fit beside the word: from a large font on,
  // or once the title wraps. A wrap counts for the width and font scale it happened at.
  const fit = `${windowWidth}:${fontScale}`;
  const [titleWrappedAt, setTitleWrappedAt] = useState<string | null>(null);
  const compactShare = fontScale > COMPACT_SHARE_SCALE || titleWrappedAt === fit;
  const card = cardDetails(user);
  useFreshPhoto(user, focused);

  const focus = useCardFocus({ bottomRoom: inset + HINT_ROOM, screenFocused: focused });
  const { inFocus } = focus;
  const shareRender = useRef<IdCardShareHandle>(null);
  const { sharing, share } = useShareIdCard(shareRender);

  const scrollRef = useRef<ComponentRef<typeof ScrollView>>(null);
  const backRef = useRef<ComponentRef<typeof View>>(null);
  const cardRef = useRef<ComponentRef<typeof View>>(null);

  // A second tap on the Account tab leaves focus mode first; at rest it scrolls to the top.
  const tabPress = useRef({ scrollToTop: () => undefined as void });
  useEffect(() => {
    tabPress.current.scrollToTop = inFocus
      ? focus.exit
      : () => scrollRef.current?.scrollTo({ y: 0, animated: true });
  });
  useScrollToTop(tabPress);

  // Screen readers: entering lands on Back once the card has arrived (its hint says where the
  // person is and what the card does), leaving lands back on the card. One spoken element each
  // way: a separate announcement would be cut off by the focus move.
  const movedFocus = useRef(inFocus);
  useEffect(() => {
    if (movedFocus.current === inFocus) return;
    movedFocus.current = inFocus;
    const timer = setTimeout(
      () => moveAccessibilityFocus(inFocus ? backRef.current : cardRef.current),
      focus.settleMs,
    );
    return () => clearTimeout(timer);
  }, [inFocus, focus.settleMs]);

  const cardLabel = [t("account.card.label"), card.name, placeOf(card.city, card.state)]
    .filter(Boolean)
    .join(", ");
  // In focus mode the page under the card is out of reach, for touch and for assistive technology.
  const away = {
    pointerEvents: inFocus ? "none" : "auto",
    accessibilityElementsHidden: inFocus,
    importantForAccessibility: inFocus ? "no-hide-descendants" : "auto",
  } as const;
  const focusOnly = {
    pointerEvents: inFocus ? "box-none" : "none",
    accessibilityElementsHidden: !inFocus,
    importantForAccessibility: inFocus ? "auto" : "no-hide-descendants",
  } as const;

  // No bottom edge: the content pads the tab bar itself, so the list at its foot stays reachable.
  return (
    <Screen bar="light" edges={[]} ownsStatusBar={focused} testID="account-screen">
      <View className="min-h-16 flex-row items-center gap-3 px-4 pt-2">
        <View className="flex-1 justify-center self-stretch">
          <Animated.View style={focus.titleStyle} {...away}>
            <Text
              accessibilityRole="header"
              className="text-title-1 text-navy-900"
              onTextLayout={(event) => {
                if (event.nativeEvent.lines.length > 1) setTitleWrappedAt(fit);
              }}
              testID="account-title"
            >
              {t("account.title")}
            </Text>
          </Animated.View>
          <Animated.View
            style={[StyleSheet.absoluteFill, styles.centered, focus.focusStyle]}
            {...focusOnly}
          >
            <Button
              ref={backRef}
              label={t("common.back")}
              accessibilityLabel={t("account.card.back")}
              accessibilityHint={t("account.card.focused")}
              variant="ghost"
              onPress={focus.exit}
              className="-ml-5 self-start"
              testID="account-card-back"
            />
          </Animated.View>
        </View>
        <Button
          label={t("account.share.label")}
          accessibilityLabel={t("account.share.a11y")}
          variant="secondary"
          glyph={compactShare ? "share" : undefined}
          loading={sharing}
          onPress={() => void share()}
          testID="account-share"
        />
      </View>
      <ScrollView
        ref={scrollRef}
        scrollEnabled={!inFocus}
        onLayout={focus.onViewportLayout}
        onScroll={focus.onScroll}
        scrollEventThrottle={16}
        contentContainerClassName="flex-grow gap-6 px-4 pt-2"
        contentContainerStyle={{ paddingBottom: inset + GUTTER }}
        testID="account-scroll"
      >
        {/* Above the rows it passes over on its way to the middle. The content grows to the
            viewport, so the middle is always inside it and the card stays touchable there. Under
            Reduce Motion it fades whole: its two faces and their shadows composite as one. */}
        <Animated.View
          onLayout={focus.onCardLayout}
          needsOffscreenAlphaCompositing={focus.reduceMotion}
          testID="account-card-stage"
          style={[styles.raised, focus.cardStyle]}
          className="items-center"
        >
          <Pressable
            ref={cardRef}
            disabled={inFocus}
            accessible={!inFocus}
            accessibilityRole="button"
            accessibilityLabel={cardLabel}
            accessibilityHint={t(
              focus.reduceMotion ? "account.card.hintStill" : "account.card.hint",
            )}
            onPress={focus.enter}
            style={({ pressed }) => (pressed ? pressedTransform : undefined)}
            testID="account-card-open"
          >
            {/* At rest the button above speaks for the card; in focus the card's own faces do. */}
            <View
              accessibilityElementsHidden={!inFocus}
              importantForAccessibility={inFocus ? "auto" : "no-hide-descendants"}
            >
              <IdCard
                {...card}
                width={cardWidth}
                interactive={inFocus && focused}
                testID="account-card"
              />
            </View>
          </Pressable>
        </Animated.View>
        {/* Fades as one layer: the list's shadow never shows through its half-faded bubbles. */}
        <Animated.View
          style={focus.awayStyle}
          needsOffscreenAlphaCompositing
          className="gap-6"
          {...away}
        >
          <AccountStats memberSince={user.member_since} />
          <AccountMenu />
        </Animated.View>
      </ScrollView>
      <Animated.View
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={[styles.hint, { bottom: inset + GUTTER }, focus.hintStyle]}
        testID="account-card-gesture"
      >
        {/* Under Reduce Motion the card holds still: it turns over, it never leans. */}
        <Text className="text-center text-callout text-gray-500">
          {t(focus.reduceMotion ? "account.card.gestureStill" : "account.card.gesture")}
        </Text>
      </Animated.View>
      <IdCardShareRender
        ref={shareRender}
        variant={card.variant}
        name={card.name}
        city={card.city}
        state={card.state}
        photoUri={card.photoUri}
        publicCode={card.publicCode}
        photoTimeoutMs={apiConfig.timeoutMs}
        testID="account-share-render"
      />
    </Screen>
  );
}

/**
 * Member since and the rating (`GET /v1/users/me/rating`, #77: "★ 4.8 · 23 ratings", "No ratings
 * yet", a skeleton while it loads, a muted "Unavailable" when it cannot), each one element for a
 * reader, side by side while each value fits on one line. A value that wraps (a long Spanish
 * phrase, a large font) stacks them, so a word is never broken across lines.
 */
function AccountStats({ memberSince }: { memberSince: string }) {
  const { width, fontScale } = useWindowDimensions();
  // A new width or font scale measures again from side by side.
  return <StatsLayout key={`${width}:${fontScale}`} memberSince={memberSince} />;
}

function StatsLayout({ memberSince }: { memberSince: string }) {
  const { t } = useTranslation();
  // Once stacked it stays stacked: side by side again could only wrap again.
  const [stacked, setStacked] = useState(false);
  const rating = useRatingStat();
  const since = formatMonth(memberSince);
  const stats: (RatingStat & { key: string; label: string })[] = [
    {
      key: "since",
      label: t("account.memberSince"),
      value: since,
      spoken: since,
      star: false,
      muted: false,
    },
    { key: "rating", label: t("account.rating"), ...rating },
  ];
  return (
    <View className={stacked ? "gap-3" : "flex-row"} testID="account-stats">
      {stats.map((stat, index) => (
        <View key={stat.key} className={stacked ? "gap-3" : "flex-1 flex-row"}>
          {index > 0 ? (
            <View
              className={stacked ? "h-px bg-navy-900/10" : "mr-4 w-px self-stretch bg-navy-900/10"}
              testID={stacked ? "account-stats-rule" : "account-stats-divider"}
            />
          ) : null}
          <View
            accessible
            accessibilityLabel={`${stat.label}, ${stat.spoken}`}
            className={stacked ? "gap-1" : "flex-1 gap-1"}
            testID={`account-${stat.key}`}
          >
            <Text className="text-footnote text-gray-500">{stat.label}</Text>
            {stat.value === null ? (
              <TextSkeleton type="headline" width="70%" testID={`account-${stat.key}-loading`} />
            ) : (
              <View className="flex-row items-center gap-1.5">
                {stat.star ? (
                  <ControlIcon
                    name="star"
                    size={STAT_STAR}
                    color={tokens.colors["green-700"]}
                    filled
                    fillColor={tokens.colors["green-500"]}
                    testID={`account-${stat.key}-star`}
                  />
                ) : null}
                <Text
                  className={cx(
                    "shrink text-headline",
                    stat.muted ? "text-gray-500" : "text-navy-900",
                  )}
                  onTextLayout={
                    stacked
                      ? undefined
                      : (event) => {
                          if (event.nativeEvent.lines.length > 1) setStacked(true);
                        }
                  }
                  testID={`account-${stat.key}-value`}
                >
                  {stat.value}
                </Text>
              </View>
            )}
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  raised: { zIndex: 10 },
  centered: { justifyContent: "center" },
  hint: { position: "absolute", left: GUTTER, right: GUTTER },
});
