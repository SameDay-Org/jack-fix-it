import { useIsFocused, useScrollToTop } from "expo-router";
import { useEffect, useRef, type ComponentRef } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import Animated from "react-native-reanimated";

import { apiConfig, useSession, type SessionUser } from "@/api";
import {
  announce,
  Button,
  IdCard,
  IdCardShareRender,
  moveAccessibilityFocus,
  placeOf,
  Screen,
  useTabBarInset,
  type IdCardShareHandle,
} from "@/components/ui";
import { formatMonth } from "@/features/quotes/format";
import { pressedTransform } from "@/theme";

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
  const { width: windowWidth } = useWindowDimensions();
  const cardWidth = Math.min(windowWidth - GUTTER * 2, MAX_CARD_WIDTH);
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

  // Screen readers: entering says where the person is, and lands on Back once the card has
  // arrived; leaving lands back on the card.
  const announcedFocus = useRef(inFocus);
  useEffect(() => {
    if (announcedFocus.current === inFocus) return;
    announcedFocus.current = inFocus;
    if (inFocus) announce(t("account.card.focused"));
    const timer = setTimeout(
      () => moveAccessibilityFocus(inFocus ? backRef.current : cardRef.current),
      focus.settleMs,
    );
    return () => clearTimeout(timer);
  }, [inFocus, focus.settleMs, t]);

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
              numberOfLines={1}
              className="text-title-1 text-navy-900"
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
        contentContainerClassName="gap-6 px-4 pt-2"
        contentContainerStyle={{ paddingBottom: inset + GUTTER }}
        testID="account-scroll"
      >
        {/* Above the rows it passes over on its way to the middle. */}
        <Animated.View
          onLayout={focus.onCardLayout}
          style={[styles.raised, focus.cardStyle]}
          className="items-center"
        >
          <Pressable
            ref={cardRef}
            disabled={inFocus}
            accessible={!inFocus}
            accessibilityRole="button"
            accessibilityLabel={cardLabel}
            accessibilityHint={t("account.card.hint")}
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
        <Animated.View style={focus.awayStyle} className="gap-6" {...away}>
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
        <Text className="text-center text-callout text-gray-500">{t("account.card.gesture")}</Text>
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

/** Member since and the rating, side by side with a divider; each one element for a reader. */
function AccountStats({ memberSince }: { memberSince: string }) {
  const { t } = useTranslation();
  const stats = [
    { key: "since", label: t("account.memberSince"), value: formatMonth(memberSince) },
    // Ratings come with reviews (#252): until then every account reads the same, quietly.
    { key: "rating", label: t("account.rating"), value: t("account.noRatings") },
  ];
  return (
    <View className="flex-row" testID="account-stats">
      {stats.map((stat, index) => (
        <View key={stat.key} className="flex-1 flex-row">
          {index > 0 ? <View className="mr-4 w-px self-stretch bg-navy-900/10" /> : null}
          <View
            accessible
            accessibilityLabel={`${stat.label}, ${stat.value}`}
            className="flex-1 gap-1"
            testID={`account-${stat.key}`}
          >
            <Text className="text-footnote text-gray-500">{stat.label}</Text>
            <Text className="text-headline text-navy-900">{stat.value}</Text>
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
