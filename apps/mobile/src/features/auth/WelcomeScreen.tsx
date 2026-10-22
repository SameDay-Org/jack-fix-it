import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View, type LayoutChangeEvent } from "react-native";
import Animated, {
  interpolateColor,
  useAnimatedStyle,
  useReducedMotion,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useSession } from "@/api";
import { Screen } from "@/components/ui";
import { BrandHero } from "@/features/launch/BrandHero";
import { tokens } from "@/theme";

import { WelcomeActions } from "./components/WelcomeActions";
import { CONTENT_FROM } from "./panelHandoff";
import { usePanelTransition } from "./usePanelTransition";

const { white, "gray-50": page } = tokens.colors;
const { xl } = tokens.radius;
const { slidePx, panelHeroDim } = tokens.motion;

// The two ways in. `from: "welcome"` gives them the panel hand-off (see `risenFromWelcome`).
const TO_ROLE = { pathname: "/(auth)/role", params: { from: "welcome" } } as const;
const TO_LOGIN = { pathname: "/(auth)/login", params: { from: "welcome" } } as const;

/**
 * The first screen: the brand hero (the navy hero with the tagline, one lime word, and the support
 * line) and a white bubble below with the two ways in. No other action lives here until its flow
 * exists. The bubble pads the bottom inset itself, so the Screen pads no edge. The hero is the one
 * the launch intro draws, so the intro fades into this screen as one sentence.
 *
 * Tapping a way in makes the bubble rise into the next screen (#148): it slides up to the top of
 * the screen (a skirt below it keeps the area it leaves covered), its top corners square off and it
 * takes the page color while the actions fade and the hero dims and drifts up; the destination
 * then fades in exactly where the panel ended. The bubble keeps its place in the layout, so the
 * hero's geometry is the intro's at rest and through the motion.
 */
export function WelcomeScreen() {
  const { t } = useTranslation();
  const { top } = useSafeAreaInsets();
  const { cleanupPending } = useSession();
  const words = t("launch.words", { returnObjects: true });
  const reduceMotion = useReducedMotion();
  const { progress, travel, bar, busy, setGeometry, go } = usePanelTransition({
    reduceMotion,
    destinations: [TO_ROLE, TO_LOGIN],
  });
  const [skirtHeight, setSkirtHeight] = useState(0);

  const onPanelLayout = ({ nativeEvent }: LayoutChangeEvent) => {
    const restingTop = nativeEvent.layout.y;
    setGeometry({ restingTop, topInset: top });
    setSkirtHeight(restingTop + top);
  };

  const heroStyle = useAnimatedStyle(() => ({
    opacity: 1 - (1 - panelHeroDim) * progress.value,
    transform: [{ translateY: -slidePx * progress.value }],
  }));
  const panelStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(progress.value, [0, 1], [white, page]),
    borderTopLeftRadius: xl * (1 - progress.value),
    borderTopRightRadius: xl * (1 - progress.value),
    transform: [{ translateY: -travel.value * progress.value }],
  }));
  // The skirt rises with the panel and covers what the panel leaves behind, down to the bottom
  // edge. It is a sibling anchored to the container's bottom, not a child of the padded panel:
  // Yoga resolves an absolute child's percentage offsets against the content box, so a `top: 100%`
  // skirt inside the panel ended a padding short of the screen's edge. Its top tucks a corner
  // radius under the panel: two edges meeting at a fractional offset left a hairline of navy.
  const skirtStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(progress.value, [0, 1], [white, page]),
    transform: [{ translateY: -travel.value * progress.value }],
  }));
  const actionsStyle = useAnimatedStyle(() => ({
    opacity: Math.max(0, 1 - progress.value / CONTENT_FROM),
    transform: [{ translateY: -slidePx * progress.value }],
  }));

  return (
    <Screen bar={bar} edges={[]} testID="welcome-screen">
      {/* Covered (or on its way up or down), Welcome is out of the accessibility tree: on Android
          the destination is a transparent screen over it, and a reader must not reach the hero
          underneath. */}
      <View
        className="flex-1 bg-navy-900"
        importantForAccessibility={busy ? "no-hide-descendants" : "auto"}
        accessibilityElementsHidden={busy}
        testID="welcome-body"
      >
        {/* Navy under the status bar, below the panel: Screen's backdrop strip follows `bar`, and
            its swap must never show beside the panel's top edge, in either direction. */}
        <View
          pointerEvents="none"
          className="absolute left-0 right-0 bg-navy-900"
          style={{ top: -top, height: top }}
          testID="welcome-bar-strip"
        />
        {/* A plain flex-1 wrapper: the hero keeps the intro's geometry, and only dims and drifts. */}
        <Animated.View className="flex-1" style={heroStyle} testID="welcome-hero">
          <BrandHero
            word={<Text className="text-display text-green-500">{words[0]}</Text>}
            testID="welcome-headline"
          />
        </Animated.View>
        <Animated.View
          pointerEvents="none"
          style={[
            skirtStyle,
            {
              position: "absolute",
              left: 0,
              right: 0,
              bottom: -skirtHeight,
              height: skirtHeight + xl,
            },
          ]}
          testID="welcome-actions-skirt"
        />
        <WelcomeActions
          cleanupPending={cleanupPending}
          onGetStarted={() => go(TO_ROLE)}
          onLogin={() => go(TO_LOGIN)}
          style={panelStyle}
          actionsStyle={actionsStyle}
          busy={busy}
          onLayout={onPanelLayout}
          testID="welcome-actions"
        />
      </View>
    </Screen>
  );
}
