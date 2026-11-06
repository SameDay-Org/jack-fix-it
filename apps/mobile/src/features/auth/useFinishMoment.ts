import { useEffect, useRef, useState } from "react";
import type { LayoutChangeEvent } from "react-native";
import {
  Easing,
  ReduceMotion,
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

import { tokens } from "@/theme";

/**
 * Where the sign-up stands: on its steps; on its way out of them (the steps fading); or finished,
 * the card in the middle of the page under "Account created!".
 */
export type FinishStage = "steps" | "leaving" | "finished";

// The fades play under Reduce Motion too: they are its version of the card's move.
const FADE = { duration: tokens.motion.transitionMs, reduceMotion: ReduceMotion.Never };
const MOVE = { duration: tokens.motion.stepSlideMs, easing: Easing.out(Easing.cubic) };
/** The longest the move waits for the headline's first layout before it starts anyway. */
const LAYOUT_WAIT_MS = 120;
/** Room kept between the card and the action under it. */
const ACTION_GAP = 24;

export type FinishMoment = {
  stage: FinishStage;
  /** The last step is done: the steps fade, then the card moves to the middle. */
  finish: () => void;
  /** Layout readings the move is computed from, all in the scroll content's coordinates. */
  onCardLayout: (event: LayoutChangeEvent) => void;
  onHeadlineLayout: (event: LayoutChangeEvent) => void;
  onActionLayout: (event: LayoutChangeEvent) => void;
  /** The back row, the progress and the step: they fade out as the flow finishes. */
  stepsStyle: ReturnType<typeof useAnimatedStyle>;
  /** The card: it moves to the middle (or, under Reduce Motion, fades out and back in there). */
  cardStyle: ReturnType<typeof useAnimatedStyle>;
  /** "Account created!": it fades in above the card once the card is in place. */
  headlineStyle: ReturnType<typeof useAnimatedStyle>;
  /** The action: it fades out with the steps and back in as the way into the app. */
  actionStyle: ReturnType<typeof useAnimatedStyle>;
};

/**
 * The sign-up's last moment (#250 §1, #295): once the phone is verified the steps fade away, the
 * card glides to the middle of the page, and "Account created! Here's your ID:" and the way into
 * the app fade in. Under Reduce Motion the card fades out and back in, in place. A flow reopened
 * with nothing left to answer (`startFinished`) shows the finished page at once, faded in.
 *
 * The card is the same view all along and nothing above it leaves the layout, so it never jumps:
 * it is only translated, to a target read on the UI thread from the latest layout (the keyboard
 * going down moves the action, and the target follows it). `onArrived` runs once the headline is
 * there, for focus.
 */
export function useFinishMoment(startFinished: boolean, onArrived: () => void): FinishMoment {
  const reduceMotion = useReducedMotion();
  const [stage, setStage] = useState<FinishStage>(startFinished ? "finished" : "steps");
  const exit = useSharedValue(startFinished ? 1 : 0);
  const move = useSharedValue(0);
  const reveal = useSharedValue(0);
  const cardOpacity = useSharedValue(startFinished ? 0 : 1);
  const cardY = useSharedValue(0);
  const cardHeight = useSharedValue(0);
  const headlineHeight = useSharedValue(0);
  const actionY = useSharedValue(0);
  const arrived = useRef(false);
  const onArrivedRef = useRef(onArrived);
  useEffect(() => {
    onArrivedRef.current = onArrived;
  });

  const finish = () => {
    if (stage !== "steps") return;
    setStage("leaving");
    const finished = (done?: boolean) => {
      "worklet";
      if (done) runOnJS(setStage)("finished");
    };
    exit.set(withTiming(1, FADE, finished));
    if (reduceMotion) cardOpacity.set(withTiming(0, FADE));
  };

  const show = () => {
    reveal.set(withTiming(1, FADE));
    cardOpacity.set(withTiming(1, FADE));
    onArrivedRef.current();
  };
  const arrive = () => {
    if (arrived.current) return;
    arrived.current = true;
    if (reduceMotion || startFinished) {
      move.set(1);
      show();
      return;
    }
    move.set(
      withTiming(1, MOVE, (done) => {
        "worklet";
        if (done) runOnJS(show)();
      }),
    );
  };

  // The headline mounts with the finished stage; its layout starts the move (or this, if none
  // comes: the move must not wait on it forever).
  useEffect(() => {
    if (stage !== "finished") return;
    const fallback = setTimeout(arrive, LAYOUT_WAIT_MS);
    return () => clearTimeout(fallback);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `arrive` runs once, guarded by its ref
  }, [stage]);

  const stepsStyle = useAnimatedStyle(() => ({ opacity: 1 - exit.value }));
  const actionStyle = useAnimatedStyle(() => ({
    opacity: exit.value < 1 ? 1 - exit.value : reveal.value,
  }));
  const headlineStyle = useAnimatedStyle(() => {
    const groupHeight = headlineHeight.value + cardHeight.value;
    const top = Math.max(0, (actionY.value - ACTION_GAP - groupHeight) / 2);
    return { opacity: reveal.value, transform: [{ translateY: top }] };
  });
  const cardStyle = useAnimatedStyle(() => {
    const groupHeight = headlineHeight.value + cardHeight.value;
    const top = Math.max(0, (actionY.value - ACTION_GAP - groupHeight) / 2);
    const target = top + headlineHeight.value;
    return {
      opacity: cardOpacity.value,
      transform: [{ translateY: move.value * (target - cardY.value) }],
    };
  });

  return {
    stage,
    finish,
    onCardLayout: ({ nativeEvent: { layout } }) => {
      cardY.set(layout.y);
      cardHeight.set(layout.height);
    },
    onHeadlineLayout: ({ nativeEvent: { layout } }) => {
      headlineHeight.set(layout.height);
      arrive();
    },
    onActionLayout: ({ nativeEvent: { layout } }) => actionY.set(layout.y),
    stepsStyle,
    cardStyle,
    headlineStyle,
    actionStyle,
  };
}
