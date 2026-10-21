import { useEffect, useRef, useState } from "react";
import { Text, useWindowDimensions, View, type LayoutChangeEvent } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withSequence,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";

import { tokens } from "@/theme";

import { cx } from "./cx";
import { swapSteps, widthAt, wordFrame } from "./wordSwap";

type TypeToken = keyof typeof tokens.fontSize;

// Static class names, so Tailwind sees every one of them.
const TEXT_CLASS: Record<TypeToken, string> = {
  display: "text-display",
  "title-1": "text-title-1",
  "title-2": "text-title-2",
  headline: "text-headline",
  body: "text-body",
  callout: "text-callout",
  footnote: "text-footnote",
  caption: "text-caption",
};

export type WordRotatorProps = {
  words: readonly string[];
  /** Type token: the words' text style, and the clip height (one line of it, at the device's font scale). */
  type: TypeToken;
  /** Time from one word settling to the next settling. */
  intervalMs: number;
  /** Length of the slide (or crossfade) itself; the rest of the interval is the hold. */
  transitionMs: number;
  /** Color classes for the words; the type classes come from `type`. */
  className?: string;
  /** Index the run ends on, after every word has shown once. */
  stopAt?: number;
  /** Called with the new index each time a word settles. */
  onCycle?: (index: number) => void;
  /** Called once every word is measured and the first frame is final; good moment to lift a splash. */
  onReady?: () => void;
  testID?: string;
};

/**
 * Word Swap: one word of a sentence rolls to the next while the rest stays put. The outgoing word
 * slides up and out as the incoming one rolls in from below, inside a clip one line tall, and the
 * clip's width tweens between the two words' measured widths so the text after it never jumps.
 * Everything runs on the UI thread from one shared cycle value (`withSequence` of timings); no JS
 * timer drives frames. Under Reduce Motion the words crossfade in place. Screen readers do not
 * see the rotating words: the sentence around the rotator carries one static label.
 */
export function WordRotator({
  words,
  type,
  intervalMs,
  transitionMs,
  className,
  stopAt = 0,
  onCycle,
  onReady,
  testID,
}: WordRotatorProps) {
  const { fontScale } = useWindowDimensions();
  const reduceMotion = useReducedMotion();
  const lineHeight = tokens.fontSize[type].lineHeight * fontScale;
  const textClass = cx(TEXT_CLASS[type], className);

  const cycle = useSharedValue(0);
  const widths = useSharedValue<number[]>([]);
  const measured = useSharedValue(false);
  const [ready, setReady] = useState(false);
  const pending = useRef(new Map<number, number>());
  const onCycleRef = useRef(onCycle);
  onCycleRef.current = onCycle;

  const record = (index: number, width: number) => {
    pending.current.set(index, width);
    if (pending.current.size < words.length) return;
    widths.value = words.map((_, i) => pending.current.get(i) ?? 0);
    measured.value = true;
    setReady(true);
  };

  // The run starts once the first frame is final, so nothing moves before it is measured.
  useEffect(() => {
    if (!ready) return;
    onReady?.();
    const steps = swapSteps(words.length, stopAt);
    if (steps === 0 || words.length < 2) return;
    const easing = Easing.out(Easing.cubic);
    const hold = Math.max(intervalMs - transitionMs, 0);
    const settle = (index: number) => onCycleRef.current?.(index);
    cycle.value = withSequence(
      ...Array.from({ length: steps }, (_, k) =>
        withDelay(
          hold,
          withTiming(k + 1, { duration: transitionMs, easing }, (finished) => {
            if (finished) runOnJS(settle)((k + 1) % words.length);
          }),
        ),
      ),
    );
    return () => cancelAnimation(cycle);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a run is fixed by its first frame; `ready` is the only trigger
  }, [ready]);

  const clipStyle = useAnimatedStyle(() =>
    measured.value ? { width: widthAt(cycle.value, widths.value) } : {},
  );

  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      testID={testID}
    >
      <Animated.View
        style={[{ height: lineHeight, overflow: "hidden" }, clipStyle]}
        testID={testID && `${testID}-clip`}
      >
        {words.map((word, index) => (
          <RotatingWord
            key={`${index}-${word}`}
            word={word}
            index={index}
            count={words.length}
            cycle={cycle}
            lineHeight={lineHeight}
            slide={!reduceMotion}
            className={textClass}
            testID={testID && `${testID}-word-${index}`}
          />
        ))}
      </Animated.View>
      {/* Measurement pass: the same words in the same style, invisible, each reporting its width. */}
      <View
        pointerEvents="none"
        style={{ position: "absolute", opacity: 0 }}
        testID={testID && `${testID}-measure`}
      >
        {words.map((word, index) => (
          <Text
            key={`${index}-${word}`}
            numberOfLines={1}
            className={textClass}
            onLayout={(event: LayoutChangeEvent) => record(index, event.nativeEvent.layout.width)}
          >
            {word}
          </Text>
        ))}
      </View>
    </View>
  );
}

type RotatingWordProps = {
  word: string;
  index: number;
  count: number;
  cycle: SharedValue<number>;
  lineHeight: number;
  slide: boolean;
  className: string;
  testID?: string;
};

function RotatingWord({
  word,
  index,
  count,
  cycle,
  lineHeight,
  slide,
  className,
  testID,
}: RotatingWordProps) {
  const frame = useAnimatedStyle(() => {
    const { translateY, opacity } = wordFrame(cycle.value, index, count, lineHeight, slide);
    return { opacity, transform: [{ translateY }] };
  });

  return (
    <Animated.Text
      numberOfLines={1}
      style={[{ position: "absolute", left: 0, top: 0 }, frame]}
      className={className}
      testID={testID}
    >
      {word}
    </Animated.Text>
  );
}
