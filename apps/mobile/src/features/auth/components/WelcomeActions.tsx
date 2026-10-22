import { useTranslation } from "react-i18next";
import { Text, type LayoutChangeEvent, type StyleProp, type ViewStyle } from "react-native";
import Animated, { type AnimatedStyle } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button } from "@/components/ui";
import { continuousCorners, tokens } from "@/theme";

type WelcomeActionsProps = {
  /** A sign-out could not clear the device: say so above the actions. */
  cleanupPending: boolean;
  onGetStarted: () => void;
  onLogin: () => void;
  /**
   * Takes its space but shows nothing and takes no taps or focus: the launch intro reserves the
   * area so its hero sits exactly where Welcome's does.
   */
  hidden?: boolean;
  /** Welcome's panel rise (#148): the bubble's animated style (its rise, corners and color). */
  style?: StyleProp<AnimatedStyle<ViewStyle>>;
  /** The actions' animated style: they fade and slide up as the bubble rises. */
  actionsStyle?: StyleProp<AnimatedStyle<ViewStyle>>;
  /** A transition is under way: the actions take no taps. */
  busy?: boolean;
  onLayout?: (event: LayoutChangeEvent) => void;
  testID?: string;
};

// The bubble's resting paint is a style, not `rounded-t-xl bg-white`: the rise animates these
// same properties, and a class and an animated style must never both own one.
const BUBBLE = {
  backgroundColor: tokens.colors.white,
  borderTopLeftRadius: tokens.radius.xl,
  borderTopRightRadius: tokens.radius.xl,
} as const satisfies ViewStyle;

/**
 * Welcome's white bubble with the two ways in. It pads the bottom inset itself, so the screen
 * above it pads no edge.
 */
export function WelcomeActions({
  cleanupPending,
  onGetStarted,
  onLogin,
  hidden = false,
  style,
  actionsStyle,
  busy = false,
  onLayout,
  testID,
}: WelcomeActionsProps) {
  const { t } = useTranslation();
  const { bottom } = useSafeAreaInsets();

  return (
    <Animated.View
      style={[continuousCorners, BUBBLE, { paddingBottom: bottom }, hidden && { opacity: 0 }, style]}
      pointerEvents={hidden ? "none" : "auto"}
      importantForAccessibility={hidden ? "no-hide-descendants" : "auto"}
      accessibilityElementsHidden={hidden}
      onLayout={onLayout}
      testID={testID}
    >
      <Animated.View
        className="gap-3 px-4 pb-4 pt-6"
        style={actionsStyle}
        pointerEvents={busy ? "none" : "auto"}
      >
        {cleanupPending ? (
          <Text
            accessibilityRole="alert"
            accessibilityLiveRegion={hidden ? "none" : "polite"}
            className="text-callout text-gray-500"
            testID={testID && `${testID}-partial-cleanup`}
          >
            {t("welcome.partialCleanup")}
          </Text>
        ) : null}
        <Button
          label={t("welcome.getStarted")}
          size="lg"
          onPress={onGetStarted}
          testID={testID && `${testID}-get-started`}
        />
        <Button
          label={t("welcome.haveAccount")}
          variant="ghost"
          onPress={onLogin}
          testID={testID && `${testID}-login`}
        />
      </Animated.View>
    </Animated.View>
  );
}
