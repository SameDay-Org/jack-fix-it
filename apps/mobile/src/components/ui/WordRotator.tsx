import { useEffect, useMemo, useRef, useState } from "react";
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
import { swapSequence, widthAt, wordFrame } from "./wordSwap";

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

// The hidden measurement row. `alignItems` stops the column from stretching every word to the
// widest one's width; the explicit width is set per render (the window's), because an absolute
// child without one is measured against its parent, and the parent here is only as wide as the
// current word: measured against that, the other words would ellipsize and report its width.
const MEASURE_ROW = { position: "absolute", opacity: 0, alignItems: "flex-start" } as const;

export type WordRotatorProps = {
  words: readonly string[];
  /** Type token: the words' text style; the clip is one line of it, as tall as the words measure. */
  type: TypeToken;
  /** Time from one word settling to the next settling. */
  intervalMs: number;
  /** Length of the slide (or crossfade) itself; the rest of the interval is the hold. */
  transitionMs: number;
  /** Color classes for the words; the type classes come from `type`. */
  className?: string;
  /** How many swaps the run makes: the next `swaps - 1` words in order, then `stopAt`. */
  swaps: number;
  /** Index the run ends on. */
  stopAt?: number;
  /** Called with the new index each time a word settles. */
  onCycle?: (index: number) => void;
  /** Called once the run has settled on its last word; at once when there is nothing to run. */
  onRunEnd?: () => void;
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
 * see the rotating words: the sentence around the rotator carries one static label. A run visits
 * `swapSequence(words.length, swaps, stopAt)`: five words and three swaps roll through three of
 * them and settle back on the first.
 */
export function WordRotator({
  words,
  type,
  intervalMs,
  transitionMs,
  className,
  swaps,
  stopAt = 0,
  onCycle,
  onRunEnd,
  onReady,
  testID,
}: WordRotatorProps) {
  const { width: windowWidth } = useWindowDimensions();
  const reduceMotion = useReducedMotion();
  const textClass = cx(TEXT_CLASS[type], className);

  const sequence = useMemo(
    () => swapSequence(words.length, swaps, stopAt),
    [words.length, swaps, stopAt],
  );
  const cycle = useSharedValue(0);
  const widths = useSharedValue<number[]>([]);
  const measured = useSharedValue(false);
  const [ready, setReady] = useState(false);
  // The words sit on a stage wide enough for the widest of them: an absolute child with an inset
  // is measured against its parent's width, and a word measured against a narrower clip would be
  // ellipsized rather than clipped.
  const [stageWidth, setStageWidth] = useState<number>();
  // The clip is as tall as the words measure, not the token's line height times the font scale:
  // Android 14+ scales large type non-linearly (34 sp is still 34 sp at a 1.3 font scale while
  // body text grows), so only the rendered height lines the clip up with the words around it.
  const [lineHeight, setLineHeight] = useState(tokens.fontSize[type].lineHeight);
  const pending = useRef(new Map<number, { width: number; height: number }>());
  // The run reads the latest callbacks without restarting when they change.
  const onCycleRef = useRef(onCycle);
  const onRunEndRef = useRef(onRunEnd);
  useEffect(() => {
    onCycleRef.current = onCycle;
    onRunEndRef.current = onRunEnd;
  }, [onCycle, onRunEnd]);

  const record = (index: number, layout: { width: number; height: number }) => {
    pending.current.set(index, layout);
    if (pending.current.size < words.length) return;
    const all = words.map((_, i) => pending.current.get(i)?.width ?? 0);
    const tallest = Math.max(...words.map((_, i) => pending.current.get(i)?.height ?? 0));
    widths.value = all;
    measured.value = true;
    setStageWidth(Math.ceil(Math.max(0, ...all)) + 1);
    if (tallest > 0) setLineHeight(Math.ceil(tallest));
    setReady(true);
  };

  // The run starts once the first frame is final, so nothing moves before it is measured.
  useEffect(() => {
    if (!ready) return;
    onReady?.();
    const steps = sequence.length - 1;
    const end = () => onRunEndRef.current?.();
    if (steps < 1 || words.length < 2) {
      end();
      return;
    }
    const easing = Easing.out(Easing.cubic);
    const hold = Math.max(intervalMs - transitionMs, 0);
    const settle = (index: number) => onCycleRef.current?.(index);
    cycle.value = withSequence(
      ...Array.from({ length: steps }, (_, k) =>
        withDelay(
          hold,
          withTiming(k + 1, { duration: transitionMs, easing }, (finished) => {
            if (!finished) return;
            runOnJS(settle)(sequence[k + 1]);
            if (k === steps - 1) runOnJS(end)();
          }),
        ),
      ),
    );
    return () => cancelAnimation(cycle);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a run is fixed by its first frame; `ready` is the only trigger
  }, [ready]);

  const clipStyle = useAnimatedStyle(() =>
    measured.value ? { width: widthAt(cycle.value, sequence, widths.value) } : {},
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
        <View
          style={{ position: "absolute", left: 0, top: 0, width: stageWidth, height: lineHeight }}
          testID={testID && `${testID}-stage`}
        >
          {words.map((word, index) => (
            <RotatingWord
              key={`${index}-${word}`}
              word={word}
              index={index}
              sequence={sequence}
              cycle={cycle}
              lineHeight={lineHeight}
              slide={!reduceMotion}
              className={textClass}
              testID={testID && `${testID}-word-${index}`}
            />
          ))}
        </View>
      </Animated.View>
      {/* Measurement pass: the same words in the same style, invisible, each reporting its width. */}
      <View
        pointerEvents="none"
        style={[MEASURE_ROW, { width: windowWidth }]}
        testID={testID && `${testID}-measure`}
      >
        {words.map((word, index) => (
          <Text
            key={`${index}-${word}`}
            numberOfLines={1}
            className={textClass}
            onLayout={(event: LayoutChangeEvent) => record(index, event.nativeEvent.layout)}
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
  sequence: readonly number[];
  cycle: SharedValue<number>;
  lineHeight: number;
  slide: boolean;
  className: string;
  testID?: string;
};

function RotatingWord({
  word,
  index,
  sequence,
  cycle,
  lineHeight,
  slide,
  className,
  testID,
}: RotatingWordProps) {
  const frame = useAnimatedStyle(() => {
    const { translateY, opacity } = wordFrame(cycle.value, index, sequence, lineHeight, slide);
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
