import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { StyleSheet, type LayoutChangeEvent } from "react-native";
import Animated, {
  Easing,
  ReduceMotion,
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";

import { tokens } from "@/theme";

export type StepSliderProps<Key extends string> = {
  /** The pane on screen. A change slides the one before it out and this one in. */
  stepKey: Key;
  /** Where the new pane comes from: 1, the right (the next step); -1, the left (a step back). */
  direction: 1 | -1;
  /**
   * Renders a pane. Called for the pane on its way out too, so its fields keep their state while
   * it leaves instead of going blank.
   */
  renderStep: (stepKey: Key) => ReactNode;
  /** The pane for `stepKey` is in place after a transition. Not called for the first pane. */
  onSettled?: (stepKey: Key) => void;
  /**
   * The page's side margin the slider sits in: the panes slide through it to the screen's edges
   * instead of being cut at the content's.
   */
  gutter?: number;
  testID?: string;
};

type Slot = "a" | "b";
/** What each slot holds, and which one is in front (the current pane). */
type Slots<Key> = { a: Key | null; b: Key | null; front: Slot };

const other = (slot: Slot): Slot => (slot === "a" ? "b" : "a");

const SLIDE = {
  duration: tokens.motion.stepSlideMs,
  easing: Easing.out(Easing.cubic),
};
// The fade is the reduced-motion transition: it must play when the OS asks for less motion.
const FADE = { duration: tokens.motion.transitionMs, reduceMotion: ReduceMotion.Never };
/** Room under the panes, inside the clip, for the shadows of what they hold (the fields'). */
const SHADOW_ROOM = 8;
/** The slide's travel before the slider has been laid out (its first transition comes later). */
const FALLBACK_TRAVEL = 320;
/**
 * The longest a transition waits for the arriving pane's first layout before it starts anyway (a
 * pane coming back to a slot that still holds it lays nothing out).
 */
const LAYOUT_WAIT_MS = 120;

type Motion = { x: SharedValue<number>; opacity: SharedValue<number> };

/**
 * One pane at a time, with a transition between them that leaves the rest of the screen alone:
 * the pane on its way out slides to the side and fades while the next one arrives from the other
 * side, and the slider's height glides from the one to the other (and as the pane grows or
 * shrinks, an error line appearing) so what sits below moves instead of jumping. Under Reduce
 * Motion the panes crossfade in place and the height changes at once.
 *
 * Two slots that are never remounted take turns holding the current pane. An arriving pane is
 * mounted in the slot that is not in front, transparent since its last pane left, so no frame
 * shows it before its transition starts; the pane in front keeps its view (and a form its text)
 * while it leaves, taking no taps and hidden from assistive technology, and its slot is emptied
 * once it is gone. Once measured, the slider's height is always its own, never the content's, so
 * the slots trading places never moves what sits below.
 */
export function StepSlider<Key extends string>({
  stepKey,
  direction,
  renderStep,
  onSettled,
  gutter = 0,
  testID,
}: StepSliderProps<Key>) {
  const reduceMotion = useReducedMotion();
  const [slots, setSlots] = useState<Slots<Key>>({ a: stepKey, b: null, front: "a" });
  // A new key goes in the slot behind and comes to the front; whatever that slot held (a pane still
  // leaving from an earlier transition) gives way to it.
  if (slots[slots.front] !== stepKey) {
    const back = other(slots.front);
    setSlots({ ...slots, [back]: stepKey, front: back });
  }

  const motion: Record<Slot, Motion> = {
    a: { x: useSharedValue(0), opacity: useSharedValue(1) },
    b: { x: useSharedValue(0), opacity: useSharedValue(0) },
  };
  const sliderWidth = useSharedValue(0);
  const height = useSharedValue(0);
  const measured = useSharedValue(0);
  const onSettledRef = useRef(onSettled);
  useEffect(() => {
    onSettledRef.current = onSettled;
  });

  // The transition's end: the slot that left is emptied, so its fields leave the tree. A transition
  // that another one replaced meanwhile ends without a word: its pane is no longer the current one.
  const shownSlots = useRef(slots);
  useLayoutEffect(() => {
    shownSlots.current = slots;
  });
  const settle = (front: Slot, key: Key) => {
    const current = shownSlots.current;
    if (current.front !== front || current[front] !== key) return;
    setSlots((latest) =>
      latest.front === front && latest[front] === key
        ? { ...latest, [other(front)]: null }
        : latest,
    );
    onSettledRef.current?.(key);
  };

  // The transition waiting for its arriving pane to be laid out. Mounting a pane (a form) can hold
  // the UI thread for a few frames: started at the commit, the slide would be mostly over by the
  // first frame that shows it.
  const pending = useRef<(() => void) | null>(null);
  const startPending = () => {
    const start = pending.current;
    pending.current = null;
    start?.();
  };

  const started = useRef<{ front: Slot; key: Key | null } | null>(null);
  useLayoutEffect(() => {
    const { front } = slots;
    const key = slots[front];
    const previous = started.current;
    started.current = { front, key };
    // Nothing to start: the first pane, or a render that left the front where it was.
    if (previous === null || (previous.front === front && previous.key === key)) return;
    const arriving = motion[front];
    const leaving = motion[other(front)];
    const finish = (finished?: boolean) => {
      "worklet";
      if (finished) runOnJS(settle)(front, key as Key);
    };
    if (reduceMotion) {
      arriving.x.set(0);
      leaving.x.set(0);
      arriving.opacity.set(withTiming(1, FADE));
      leaving.opacity.set(withTiming(0, FADE, finish));
      return;
    }
    const travel = direction * (sliderWidth.get() || FALLBACK_TRAVEL);
    // A pane that is still showing (it was leaving and comes back) moves on from where it is.
    if (arriving.opacity.get() === 0) arriving.x.set(travel);
    pending.current = () => {
      arriving.x.set(withTiming(0, SLIDE));
      arriving.opacity.set(withTiming(1, SLIDE));
      leaving.x.set(withTiming(-travel, SLIDE));
      leaving.opacity.set(withTiming(0, SLIDE, finish));
    };
    const fallback = setTimeout(startPending, LAYOUT_WAIT_MS);
    return () => clearTimeout(fallback);
    // The slots' values are stable; `settle` reads nothing that changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a transition starts once per front change
  }, [slots, direction, reduceMotion]);

  const measureSlider = (event: LayoutChangeEvent) => {
    sliderWidth.set(event.nativeEvent.layout.width);
  };
  // The pane in front sets the height: taken as is the first time (the slider's own height until
  // then), glided to after that.
  const measure = (slot: Slot) => (event: LayoutChangeEvent) => {
    if (slot !== slots.front) return;
    startPending();
    const next = event.nativeEvent.layout.height;
    const first = measured.get() === 0;
    measured.set(1);
    height.set(first || reduceMotion ? next : withTiming(next, SLIDE));
  };

  const sliderStyle = useAnimatedStyle(() => ({
    height: measured.value ? height.value : "auto",
  }));
  const styleA = useAnimatedStyle(() => ({
    opacity: motion.a.opacity.value,
    transform: [{ translateX: motion.a.x.value }],
  }));
  const styleB = useAnimatedStyle(() => ({
    opacity: motion.b.opacity.value,
    transform: [{ translateX: motion.b.x.value }],
  }));

  const slot = (name: Slot, animated: typeof styleA) => {
    const inFront = slots.front === name;
    const key = slots[name];
    return (
      <Animated.View
        key={name}
        style={[
          { paddingHorizontal: gutter, paddingBottom: SHADOW_ROOM },
          inFront ? null : styles.behind,
          animated,
        ]}
        onLayout={measure(name)}
        pointerEvents={inFront ? "auto" : "none"}
        needsOffscreenAlphaCompositing
        accessibilityElementsHidden={!inFront}
        importantForAccessibility={inFront ? "auto" : "no-hide-descendants"}
        testID={testID && (inFront ? `${testID}-current` : `${testID}-leaving`)}
      >
        {key === null ? null : renderStep(key)}
      </Animated.View>
    );
  };

  return (
    <Animated.View
      // The margins give back the room the slots add, so nothing around the slider moves.
      style={[
        styles.slider,
        { marginHorizontal: -gutter, marginBottom: -SHADOW_ROOM },
        sliderStyle,
      ]}
      onLayout={measureSlider}
      testID={testID}
    >
      {slot("a", styleA)}
      {slot("b", styleB)}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  slider: { overflow: "hidden" },
  behind: { position: "absolute", top: 0, left: 0, right: 0 },
});
