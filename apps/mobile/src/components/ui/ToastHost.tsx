import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AccessibilityInfo, Keyboard, Platform, Pressable, Text, View } from "react-native";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { tokens } from "@/theme";

import { Button } from "./Button";
import { cx } from "./cx";
import { GlassSurface } from "./GlassSurface";
import { dismissToast, useToast, type Toast, type ToastTone } from "./toast";

// The tone indicator is the one icon-only use the brief allows: a small circle, never text.
const INDICATOR: Record<ToastTone, string> = {
  neutral: "bg-gray-500",
  success: "bg-success",
  danger: "bg-danger",
};

/**
 * How far the keyboard covers the bottom of the window, 0 when it is down. iOS measures the
 * keyboard from the screen edge, home indicator included; Android's height leaves out the system
 * bars (`ReactRootView` subtracts them), so the bottom inset goes on top of it there.
 */
function useKeyboardCover(bottomInset: number): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    // iOS announces the keyboard before it moves; Android only once it is up.
    const ios = Platform.OS === "ios";
    const shown = Keyboard.addListener(ios ? "keyboardWillShow" : "keyboardDidShow", (event) =>
      setHeight(event.endCoordinates.height),
    );
    const hidden = Keyboard.addListener(ios ? "keyboardWillHide" : "keyboardDidHide", () =>
      setHeight(0),
    );
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, []);
  if (height === 0) return 0;
  return Platform.OS === "android" ? height + bottomInset : height;
}

/**
 * Renders the current toast as a light glass pill above the bottom safe area, or above the
 * keyboard while it is up. Mounted once by the
 * root layout. It slides and fades over `motion.transitionMs` through an animated style on one
 * persistent view (layout animations would take it out of the accessibility tree on Android), or
 * appears in place under Reduce Motion. It announces its message to assistive technology, never
 * takes focus, and a tap or the dismiss action hides it.
 */
export function ToastHost() {
  const toast = useToast();
  const reduceMotion = useReducedMotion();
  const { t } = useTranslation();
  const { bottom } = useSafeAreaInsets();
  const keyboardCover = useKeyboardCover(bottom);
  const { transitionMs, slidePx } = tokens.motion;

  // The last toast stays mounted while it fades out; a replacement swaps the content in place.
  const [shown, setShown] = useState<Toast | null>(toast);
  if (toast && toast !== shown) setShown(toast);

  const progress = useSharedValue(toast ? 1 : 0);

  useEffect(() => {
    const duration = reduceMotion ? 0 : transitionMs;
    if (toast) {
      AccessibilityInfo.announceForAccessibility(toast.message);
      progress.value = withTiming(1, { duration });
      return;
    }
    progress.value = withTiming(0, { duration }, (finished) => {
      if (finished) runOnJS(setShown)(null);
    });
  }, [toast, reduceMotion, progress, transitionMs]);

  const motion = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ translateY: (1 - progress.value) * slidePx }],
  }));

  if (!shown) return null;

  return (
    <View
      pointerEvents="box-none"
      testID="toast-host"
      className="absolute inset-x-0 bottom-0"
      style={{ paddingBottom: Math.max(bottom, keyboardCover) }}
    >
      <Animated.View testID="toast" style={motion} className="px-4 pb-4">
        <Pressable
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          onPress={() => dismissToast(shown.id)}
        >
          <GlassSurface
            tone="light"
            shape="pill"
            className="flex-row items-center gap-3 py-1 pl-4 pr-1"
          >
            <View className={cx("h-3 w-3 rounded-pill", INDICATOR[shown.tone])} />
            <Text className="flex-1 text-callout text-navy-900">{shown.message}</Text>
            <Button
              label={t("common.dismiss")}
              variant="ghost"
              onPress={() => dismissToast(shown.id)}
            />
          </GlassSurface>
        </Pressable>
      </Animated.View>
    </View>
  );
}
