import { useIsFocused, useScrollToTop, type Href } from "expo-router";
import { useEffect, useRef, type ComponentRef } from "react";
import { Trans, useTranslation } from "react-i18next";
import { ScrollView, Text, type LayoutChangeEvent } from "react-native";
import Animated, { useAnimatedStyle, useReducedMotion } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useSession } from "@/api";
import { Screen } from "@/components/ui";
import { CONTENT_FROM, usePanelTransition } from "@/features/auth";
import { useOpenPhoneStepAfterSignUp } from "@/features/phone/useOpenPhoneStepAfterSignUp";
import { forgetUnopenedRequest, startRequest } from "@/features/request";
import { tokens } from "@/theme";

import { CategoryCards } from "./CategoryCards";

const { xl } = tokens.radius;
const { slidePx, panelHeroDim } = tokens.motion;
// Nothing to build ahead: the flow is built for the category tapped.
const NO_PREFETCH: Href[] = [];

/**
 * The customer's home, the Home tab: a navy hero that asks what is going on and points at the
 * categories below, the one way into a request (every request starts from a category, #232).
 * Account is a tab now, so the hero carries no account control.
 *
 * Right after a sign-up it opens the phone step over itself, once, and shows only its bare page
 * until then (`useOpenPhoneStepAfterSignUp`). Pressing the Home tab again scrolls it to the top.
 *
 * A category card opens the request with the panel rise Welcome uses (`usePanelTransition`): the
 * categories panel slides up to the top of the screen, its corners square off and its cards fade
 * while the hero dims and drifts and the tab bar slides away; the flow's first step rides it in.
 * Back from the flow lowers it again.
 */
export function CustomerHomeScreen() {
  const { t } = useTranslation();
  const { user } = useSession();
  const phoneStepOffered = useOpenPhoneStepAfterSignUp();
  // Tabs stay mounted while another one shows: only the focused tab owns the status bar.
  const focused = useIsFocused();
  const scrollRef = useRef<ComponentRef<typeof ScrollView>>(null);
  useScrollToTop(scrollRef);
  const { top } = useSafeAreaInsets();
  const reduceMotion = useReducedMotion();
  const { progress, travel, bar, busy, setGeometry, go } = usePanelTransition({
    reduceMotion,
    destinations: NO_PREFETCH,
  });
  // Back at rest after a rise: if the push went nowhere (no flow mounted to forget it), the start
  // it made is dropped, so nothing of it rides into a later way in.
  const wasBusy = useRef(false);
  useEffect(() => {
    if (wasBusy.current && !busy) forgetUnopenedRequest();
    wasBusy.current = busy;
  }, [busy]);
  // Where the panel starts: its top in the scroll content, less how far the page is scrolled.
  const panelY = useRef(0);
  const scrollY = useRef(0);

  const open = (slug: string) =>
    startRequest(slug, (href) => {
      if (!go(href)) return false;
      // Read on the UI thread from the rise's first frame on, which comes after this.
      setGeometry({ restingTop: Math.max(0, panelY.current - scrollY.current), topInset: top });
      return true;
    });

  const heroStyle = useAnimatedStyle(() => ({
    opacity: 1 - (1 - panelHeroDim) * progress.value,
    transform: [{ translateY: -slidePx * progress.value }],
  }));
  const panelStyle = useAnimatedStyle(() => ({
    borderTopLeftRadius: xl * (1 - progress.value),
    borderTopRightRadius: xl * (1 - progress.value),
    transform: [{ translateY: -travel.value * progress.value }],
  }));
  const contentStyle = useAnimatedStyle(() => ({
    opacity: Math.max(0, 1 - progress.value / CONTENT_FROM),
    transform: [{ translateY: -slidePx * progress.value }],
  }));

  if (!user) return null;
  if (phoneStepOffered) {
    return (
      <Screen bar="light" ownsStatusBar={focused} testID="customer-home">
        {null}
      </Screen>
    );
  }

  // No bottom edge: the categories panel pads the tab bar itself. Rising (or covering the screen,
  // or lowering), Home takes no taps and is out of the accessibility tree, and its scroll view
  // stops clipping so the panel can cover the status bar strip too.
  return (
    <Screen bar="hero" statusBar={bar} edges={[]} ownsStatusBar={focused} testID="customer-home">
      <ScrollView
        ref={scrollRef}
        contentContainerClassName="flex-grow"
        onScroll={({ nativeEvent }) => {
          scrollY.current = nativeEvent.contentOffset.y;
        }}
        scrollEventThrottle={16}
        pointerEvents={busy ? "none" : "auto"}
        importantForAccessibility={busy ? "no-hide-descendants" : "auto"}
        accessibilityElementsHidden={busy}
        style={busy ? { overflow: "visible" } : undefined}
        testID="customer-home-scroll"
      >
        <Animated.View
          style={heroStyle}
          className="gap-3 px-4 pb-8 pt-8"
          testID="customer-home-hero"
        >
          <Text accessibilityRole="header" className="text-display text-white">
            <Trans
              i18nKey="home.headline"
              components={{ accent: <Text className="text-green-500" /> }}
            />
          </Text>
          <Text className="text-body text-white">{t("home.support")}</Text>
        </Animated.View>
        <CategoryCards
          onOpen={open}
          panelStyle={panelStyle}
          contentStyle={contentStyle}
          onPanelLayout={({ nativeEvent }: LayoutChangeEvent) => {
            panelY.current = nativeEvent.layout.y;
          }}
        />
      </ScrollView>
    </Screen>
  );
}
