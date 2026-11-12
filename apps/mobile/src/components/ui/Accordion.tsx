import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View, type LayoutChangeEvent } from "react-native";
import Animated, {
  Easing,
  runOnJS,
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
 * The row folding shut above the one just opened. Its height leaves the page from under the
 * reader, so the scroll gives the same amount back, frame by frame: the row they tapped stays
 * where their finger is. `from` and `full` are read on the first frame of the fold.
 */
type Pull = { id: string; from: number | null; full: number | null };

export type AccordionAnchor = {
  scrollRef: AnimatedRef<Animated.ScrollView>;
  /** The scroll view's current offset. */
  offset: SharedValue<number>;
  pull: SharedValue<Pull | null>;
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
  const pull = useSharedValue<Pull | null>(null);
  const onScroll = useAnimatedScrollHandler((event) => {
    offset.value = event.contentOffset.y;
  });
  const anchor = useMemo<AccordionAnchor>(
    () => ({ scrollRef, offset, pull }),
    [scrollRef, offset, pull],
  );

  const toggle = (id: Id) => {
    const closesAbove = open !== null && open !== id && order.indexOf(open) < order.indexOf(id);
    pull.set(closesAbove ? { id: open, from: null, full: null } : null);
    setOpen(open === id ? null : id);
  };

  return {
    scroll: { ref: scrollRef, onScroll },
    row: (id: Id) => ({ id, open: open === id, onToggle: () => toggle(id), anchor }),
  };
}

export type AccordionRowProps = {
  /** The row's name in its list, as given to `useAccordion`. */
  id: string;
  title: string;
  open: boolean;
  onToggle: () => void;
  /** The body under the title: mounted while the row is open and while it folds away. */
  children: ReactNode;
  /** From `useAccordion`: keeps the tapped row in place while a row above it folds. */
  anchor?: AccordionAnchor;
  testID?: string;
};

/**
 * A row that opens in place: its title is a button that says whether it is expanded, and its body
 * unfolds under it over `motion.transitionMs` (at once under Reduce Motion). A shut row's body is
 * not in the tree, so a screen reader never lands on hidden text. Rows sit in a `ListGroup`.
 */
export function AccordionRow({
  id,
  title,
  open,
  onToggle,
  children,
  anchor,
  testID,
}: AccordionRowProps) {
  const reduceMotion = useReducedMotion();
  const [pressed, pressIn, pressOut] = useFlag();
  const [shown, setShown] = useState(open);
  // Opening mounts the body in the same render; it leaves once the fold has reached zero.
  if (open && !shown) setShown(true);

  const progress = useSharedValue(open ? 1 : 0);
  const bodyHeight = useSharedValue(0);
  const scrollRef = anchor?.scrollRef;
  const offset = anchor?.offset;
  const pull = anchor?.pull;

  useEffect(() => {
    const config = reduceMotion ? AT_ONCE : FOLD;
    if (open) {
      progress.value = withTiming(1, config);
      return;
    }
    // A row that was never opened has nothing to fold.
    if (!shown) return;
    progress.value = withTiming(0, config, (finished) => {
      if (finished) runOnJS(setShown)(false);
    });
  }, [open, shown, progress, reduceMotion]);

  useAnimatedReaction(
    () => bodyHeight.value * progress.value,
    (height, before) => {
      const pulled = pull?.get();
      if (!scrollRef || !offset || !pull || !pulled) return;
      if (pulled.id !== id || before === null || height >= before) return;
      const from = pulled.from ?? offset.get();
      const full = pulled.full ?? before;
      if (pulled.from === null) pull.set({ id, from, full });
      scrollTo(scrollRef, 0, Math.max(0, from - (full - height)), false);
    },
  );

  const foldStyle = useAnimatedStyle(() => ({ height: bodyHeight.value * progress.value }));
  const chevronStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${CHEVRON_SHUT_DEG + progress.value * CHEVRON_TURN_DEG}deg` }],
  }));

  const measure = (event: LayoutChangeEvent) => {
    bodyHeight.value = event.nativeEvent.layout.height;
  };

  return (
    <View testID={testID}>
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
        <Animated.View style={[styles.fold, foldStyle]} testID={testID && `${testID}-fold`}>
          {/* Out of the flow, so its height is the text's own and never the fold's: the fold
              follows this measure, not the other way round. */}
          <View
            onLayout={measure}
            style={styles.body}
            className="px-4 pb-4"
            testID={testID && `${testID}-body`}
          >
            {children}
          </View>
        </Animated.View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fold: { overflow: "hidden" },
  body: { position: "absolute", top: 0, right: 0, left: 0 },
});
