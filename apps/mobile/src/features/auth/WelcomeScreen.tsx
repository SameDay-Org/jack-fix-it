import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Text, View, type LayoutChangeEvent } from "react-native";
import Animated, {
  interpolateColor,
  useAnimatedStyle,
  useReducedMotion,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useSession } from "@/api";
import { Button, Screen } from "@/components/ui";
import { continuousCorners, tokens } from "@/theme";

import { usePanelTransition } from "./usePanelTransition";

const { white, "gray-50": page } = tokens.colors;
const { xl } = tokens.radius;
const { slidePx, panelHeroDim } = tokens.motion;

/**
 * The first screen: the navy hero with the tagline (one lime word, per the brief) and the support
 * line, and a white bubble below with the two ways in. No other action lives here until its flow
 * exists. The bubble pads the bottom inset itself, so the Screen pads no edge.
 *
 * Tapping a way in makes the bubble rise into the next screen: it slides up to the top of the
 * screen (a skirt below it keeps the area it leaves covered), its top corners square off and it
 * takes the page color while the actions fade and the hero dims and drifts up; the destination
 * then fades in exactly where the panel ended. The bubble keeps its place in the layout, so the
 * hero's geometry is the same as before the motion.
 */
export function WelcomeScreen() {
  const { t } = useTranslation();
  const { top, bottom } = useSafeAreaInsets();
  const { cleanupPending } = useSession();
  const reduceMotion = useReducedMotion();
  const { progress, travel, bar, busy, setGeometry, go } = usePanelTransition({ reduceMotion });
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
  const skirtStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(progress.value, [0, 1], [white, page]),
  }));
  const actionsStyle = useAnimatedStyle(() => ({
    opacity: Math.max(0, 1 - 2 * progress.value),
    transform: [{ translateY: -slidePx * progress.value }],
  }));

  return (
    <Screen bar={bar} edges={[]} testID="welcome-screen">
      <View className="flex-1 bg-navy-900">
        <Animated.View
          className="flex-1 justify-center gap-6 px-6"
          style={heroStyle}
          testID="welcome-hero"
        >
          <View className="gap-3">
            <View className="h-1 w-12 rounded-pill bg-green-500" />
            <Text className="text-headline text-white">{t("brand.name")}</Text>
          </View>
          <Text className="text-display text-white" testID="welcome-tagline">
            <Trans
              i18nKey="welcome.tagline"
              components={{ accent: <Text className="text-green-500" /> }}
            />
          </Text>
          <Text className="text-body text-white">{t("welcome.support")}</Text>
        </Animated.View>
        <Animated.View
          style={[continuousCorners, panelStyle, { paddingBottom: bottom }]}
          onLayout={onPanelLayout}
          testID="welcome-actions"
        >
          {/* Covers what the panel leaves behind as it rises; the same color, no corners. */}
          <Animated.View
            pointerEvents="none"
            style={[
              skirtStyle,
              { position: "absolute", left: 0, right: 0, top: "100%", height: skirtHeight },
            ]}
            testID="welcome-actions-skirt"
          />
          <Animated.View
            className="gap-3 px-4 pb-4 pt-6"
            style={actionsStyle}
            pointerEvents={busy ? "none" : "auto"}
          >
            {cleanupPending ? (
              <Text
                accessibilityRole="alert"
                accessibilityLiveRegion="polite"
                className="text-callout text-gray-500"
                testID="welcome-partial-cleanup"
              >
                {t("welcome.partialCleanup")}
              </Text>
            ) : null}
            <Button
              label={t("welcome.getStarted")}
              size="lg"
              onPress={() => go({ pathname: "/(auth)/role", params: { from: "welcome" } })}
              testID="welcome-get-started"
            />
            <Button
              label={t("welcome.haveAccount")}
              variant="ghost"
              onPress={() => go({ pathname: "/(auth)/login", params: { from: "welcome" } })}
              testID="welcome-login"
            />
          </Animated.View>
        </Animated.View>
      </View>
    </Screen>
  );
}
