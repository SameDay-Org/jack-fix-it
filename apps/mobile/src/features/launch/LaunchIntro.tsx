import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet } from "react-native";
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

import { useSession } from "@/api";
import { WordRotator } from "@/components/ui";
import { tokens } from "@/theme";

import { LaunchHero } from "./LaunchHero";
import { useLaunchIntro } from "./useLaunchIntro";

type LaunchIntroProps = {
  /** The first frame is final (hero rows laid out, every word measured): lift the native splash. */
  onReady: () => void;
  /** The exit finished; the caller unmounts the intro. */
  onDone: () => void;
};

/**
 * The branded start of every launch, drawn over the session gate: the navy hero with the rolling
 * word, then a short fade into whatever the gate shows, which for Welcome and the restoring frame
 * is the same hero. Tapping anywhere skips it.
 */
export function LaunchIntro({ onReady, onDone }: LaunchIntroProps) {
  const { t } = useTranslation();
  const { status } = useSession();
  const reduceMotion = useReducedMotion();
  const [runDone, setRunDone] = useState(false);
  const runEnd = useCallback(() => setRunDone(true), []);
  const { phase, skip } = useLaunchIntro({ status, reduceMotion, runDone });
  const words = t("launch.words", { returnObjects: true });
  const { wordSwapIntervalMs, wordSwapTransitionMs, launchSwaps, launchExitMs } = tokens.motion;

  // The splash lifts when the first frame is final (the shell also lifts it on exit and, at the
  // latest, at launchMaxMs, whatever happens here). Final means two things, each reported from the
  // native side: the hero's headline rows are laid out (not its wrapping fallback) and every
  // rotator word is measured. Until then the intro paints nothing: the native splash normally
  // covers that frame, but a dev client does not hold it, and what sits under the intro is the
  // same navy (the gate's static hero, or its navy frame). The gate is a shared value, not state:
  // a state dependency re-initializes the animated style on the re-render, which blanked the
  // intro for a frame or two on the device.
  const readyRef = useRef(false);
  const heroLaidOutRef = useRef(false);
  const wordsMeasuredRef = useRef(false);
  const shown = useSharedValue(0);
  const ready = () => {
    if (readyRef.current || !heroLaidOutRef.current || !wordsMeasuredRef.current) return;
    readyRef.current = true;
    shown.value = 1;
    onReady();
  };
  const heroLaidOut = () => {
    heroLaidOutRef.current = true;
    ready();
  };
  const wordsMeasured = () => {
    wordsMeasuredRef.current = true;
    ready();
  };

  const exit = useSharedValue(0);
  useEffect(() => {
    if (phase !== "exiting") return;
    exit.value = withTiming(
      1,
      { duration: launchExitMs, easing: Easing.out(Easing.cubic) },
      (finished) => {
        if (finished) runOnJS(onDone)();
      },
    );
  }, [exit, launchExitMs, onDone, phase]);

  // A fade only: the intro's last frame is Welcome's own hero (or the gate's), so any scale would
  // draw the same sentence twice, slightly apart, while it fades. The fade is composited offscreen:
  // by default Android applies the opacity to each child on its own, so the intro's navy page would
  // dim the identical hero under it and the half-faded sentence on top would not bring it back (the
  // headline read gray mid-exit). Flattened first, every pixel of the intro fades over its twin.
  const exitStyle = useAnimatedStyle(() => ({
    opacity: shown.value * (1 - exit.value),
  }));

  return (
    <Animated.View
      style={[StyleSheet.absoluteFill, exitStyle]}
      pointerEvents={phase === "exiting" ? "none" : "auto"}
      needsOffscreenAlphaCompositing
      testID="launch-intro"
    >
      {/* The tap-anywhere layer is not an accessibility node of its own: a clickable view that is
          "auto" gets its children's text as a description and TalkBack would read the hero twice. */}
      <Pressable
        accessible={false}
        importantForAccessibility="no"
        onPress={skip}
        className="flex-1"
        testID="launch-intro-tap"
      >
        {/* Skip leaves the moment the exit starts: it has nothing left to do, and Welcome's second
            action fades in on its row, so the two labels would read as one over the other. */}
        <LaunchHero
          testID="launch-hero"
          skip={phase === "exiting" ? undefined : { label: t("launch.skip"), onPress: skip }}
          onLaidOut={heroLaidOut}
          word={
            <WordRotator
              words={words}
              type="display"
              className="text-green-500"
              intervalMs={wordSwapIntervalMs}
              transitionMs={wordSwapTransitionMs}
              swaps={launchSwaps}
              stopAt={0}
              onRunEnd={runEnd}
              onReady={wordsMeasured}
              testID="launch-rotator"
            />
          }
        />
      </Pressable>
    </Animated.View>
  );
}
