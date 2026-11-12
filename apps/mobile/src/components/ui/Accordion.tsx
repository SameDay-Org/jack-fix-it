import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View, type LayoutChangeEvent } from "react-native";
import Animated, {
  Easing,
  measure,
  runOnJS,
  runOnUI,
  scrollTo,
  useAnimatedReaction,
  useAnimatedRef,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
  type AnimatedRef,
  type SharedValue,
} from "react-native-reanimated";

import { ControlIcon } from "@/components/icons";
import { tokens } from "@/theme";

import { cx } from "./cx";
import { useFlag } from "./useFlag";

const CHEVRON = 20;
/** The chevron points down on a shut row and turns half a circle to point up on an open one. */
const CHEVRON_SHUT_DEG = 90;
const CHEVRON_TURN_DEG = 180;
const FOLD = { duration: tokens.motion.transitionMs, easing: Easing.out(Easing.cubic) };
/** Under Reduce Motion the fold still runs on the UI thread, in one frame. */
const AT_ONCE = { duration: 0 };

/**
 * The row last tapped stays where the finger is. A row folding shut above it takes its height out
 * from under the reader, so the scroll gives the same amount back, frame by frame. `at` is where
 * the scroll is held: read from the scroll view when the first row starts to fold, then kept here,
 * because the scroll view reports its new offset a frame late. Each tap starts a new hold, so a
 * tap that lands while a row is still folding can leave the row a frame of that fold off. A drag
 * ends the hold.
 */
type Hold = { index: number; at: number | null };

export type AccordionAnchor = {
  scrollRef: AnimatedRef<Animated.ScrollView>;
  /** The scroll view's current offset. */
  offset: SharedValue<number>;
  hold: SharedValue<Hold | null>;
};

/**
 * A list of `AccordionRow`s with at most one open, inside one `Animated.ScrollView`: spread
 * `scroll` on the scroll view and `row(id)` on each row. `order` is the rows' ids from top to
 * bottom.
 */
export function useAccordion<Id extends string>(order: readonly Id[]) {
  const [open, setOpen] = useState<Id | null>(null);
  const scrollRef = useAnimatedRef<Animated.ScrollView>();
  const offset = useSharedValue(0);
  const hold = useSharedValue<Hold | null>(null);
  const onScroll = useAnimatedScrollHandler({
    onScroll: (event) => {
      offset.value = event.contentOffset.y;
    },
    // A drag takes the scroll back: nothing here moves the page under the reader's finger.
    onBeginDrag: () => {
      hold.value = null;
    },
  });
  const anchor = useMemo<AccordionAnchor>(
    () => ({ scrollRef, offset, hold }),
    [scrollRef, offset, hold],
  );

  const toggle = (id: Id) => {
    hold.set({ index: order.indexOf(id), at: null });
    setOpen(open === id ? null : id);
  };

  return {
    scroll: { ref: scrollRef, onScroll },
    row: (id: Id) => ({
      index: order.indexOf(id),
      open: open === id,
      onToggle: () => toggle(id),
      anchor,
    }),
  };
}

export type AccordionRowProps = {
  title: string;
  open: boolean;
  onToggle: () => void;
  /** The body under the title: mounted while the row is open and while it folds away. */
  children: ReactNode;
  /** From `useAccordion`: the row's place in the list, and the scroll view it sits in. */
  index?: number;
  anchor?: AccordionAnchor;
  testID?: string;
};

/**
 * A row that opens in place: its title is a button that says whether it is expanded, and its body
 * unfolds under it over `motion.transitionMs` (at once under Reduce Motion). A shut row's body is
 * not in the tree, so a screen reader never lands on hidden text. In a `useAccordion` list the
 * tapped row holds its place while the one above folds, and an answer that ends below the screen
 * is brought up once it has unfolded. Rows sit in a `ListGroup`.
 */
export function AccordionRow({
  title,
  open,
  onToggle,
  children,
  index,
  anchor,
  testID,
}: AccordionRowProps) {
  const reduceMotion = useReducedMotion();
  const [pressed, pressIn, pressOut] = useFlag();
  const [shown, setShown] = useState(open);
  // Opening mounts the body in the same render; it leaves once the fold has reached zero.
  if (open && !shown) setShown(true);

  const rowRef = useAnimatedRef<Animated.View>();
  const foldRef = useAnimatedRef<Animated.View>();
  const progress = useSharedValue(open ? 1 : 0);
  const bodyHeight = useSharedValue(0);
  const measured = useRef(false);
  const scrollRef = anchor?.scrollRef;
  const offset = anchor?.offset;
  const hold = anchor?.hold;
  const fold = reduceMotion ? AT_ONCE : FOLD;

  // Once unfolded, an answer that ends below the scroll view is brought up into it.
  const reveal = useCallback(() => {
    if (!scrollRef || !offset || !hold) return;
    runOnUI(() => {
      "worklet";
      // Only for the row still held: not after another tap, nor once the reader drags.
      const held = hold.get();
      if (!held || held.index !== index) return;
      const row = measure(rowRef);
      const body = measure(foldRef);
      const view = measure(scrollRef);
      if (row === null || body === null || view === null) return;
      // The end comes from the body's own height: the fold's layout can still be a frame short.
      const below = body.pageY + bodyHeight.get() - (view.pageY + view.height);
      // Never further than the title can rise: it stays the first line on screen.
      const room = row.pageY - view.pageY;
      if (below <= 0 || room <= 0) return;
      scrollTo(scrollRef, 0, (held.at ?? offset.get()) + Math.min(below, room), !reduceMotion);
    })();
  }, [bodyHeight, foldRef, hold, index, offset, reduceMotion, rowRef, scrollRef]);

  const unfold = useCallback(() => {
    progress.set(
      withTiming(1, fold, (finished) => {
        if (finished) runOnJS(reveal)();
      }),
    );
  }, [fold, progress, reveal]);

  useEffect(() => {
    if (open) {
      // A first unfold waits for the body's height (`measureBody` starts it): started blind, the
      // fold would jump to wherever the curve already is when the height lands.
      if (measured.current) unfold();
      return;
    }
    // A row that was never opened has nothing to fold.
    if (!shown) return;
    progress.set(
      withTiming(0, fold, (finished) => {
        if (finished) runOnJS(setShown)(false);
      }),
    );
  }, [open, shown, progress, fold, unfold]);

  useAnimatedReaction(
    () => bodyHeight.value * progress.value,
    (height, before) => {
      const held = hold?.get();
      if (!scrollRef || !offset || !hold || !held || index === undefined) return;
      if (index >= held.index || before === null || height >= before) return;
      const at = (held.at ?? offset.get()) - (before - height);
      hold.set({ index: held.index, at });
      scrollTo(scrollRef, 0, Math.max(0, at), false);
    },
  );

  const foldStyle = useAnimatedStyle(() => ({ height: bodyHeight.value * progress.value }));
  const chevronStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${CHEVRON_SHUT_DEG + progress.value * CHEVRON_TURN_DEG}deg` }],
  }));

  const measureBody = (event: LayoutChangeEvent) => {
    bodyHeight.set(event.nativeEvent.layout.height);
    if (measured.current) return;
    measured.current = true;
    if (open) unfold();
  };

  return (
    // Never flattened away on Android: `reveal` measures this view.
    <Animated.View ref={rowRef} collapsable={false} testID={testID}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityState={{ expanded: open }}
        onPress={onToggle}
        onPressIn={pressIn}
        onPressOut={pressOut}
        className={cx("min-h-14 flex-row items-center gap-3 px-4 py-3", pressed && "bg-navy-900/5")}
        testID={testID && `${testID}-title`}
      >
        {/* A word longer than the line at a large font is hyphenated on Android, not cut. */}
        <Text android_hyphenationFrequency="full" className="flex-1 text-headline text-navy-900">
          {title}
        </Text>
        <Animated.View style={chevronStyle}>
          <ControlIcon name="chevron" size={CHEVRON} color={tokens.colors["gray-500"]} />
        </Animated.View>
      </Pressable>
      {shown ? (
        <Animated.View
          ref={foldRef}
          style={[styles.fold, foldStyle]}
          testID={testID && `${testID}-fold`}
        >
          {/* Out of the flow, so its height is the text's own and never the fold's: the fold
              follows this measure, not the other way round. */}
          <View
            onLayout={measureBody}
            style={styles.body}
            className="px-4 pb-4"
            testID={testID && `${testID}-body`}
          >
            {children}
          </View>
        </Animated.View>
      ) : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  fold: { overflow: "hidden" },
  body: { position: "absolute", top: 0, right: 0, left: 0 },
});
