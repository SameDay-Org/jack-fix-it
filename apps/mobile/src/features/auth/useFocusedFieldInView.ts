import { useCallback, useRef, type ComponentRef } from "react";
import {
  TextInput,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollView,
} from "react-native";

/**
 * Keeps the focused field, and `margin` dp under it (its hint or error line), inside a scroll
 * view that a keyboard-avoiding view shrinks. Android scrolls a focused field into view before
 * the keyboard's padding lands, against the taller viewport, so the field could end under the
 * keyboard; this scrolls again once the viewport has shrunk. Spread the result on the ScrollView.
 */
export function useFocusedFieldInView(margin: number) {
  const ref = useRef<ComponentRef<typeof ScrollView>>(null);
  const offset = useRef(0);
  const viewport = useRef(0);

  const reveal = useCallback(() => {
    const scroll = ref.current;
    const field = TextInput.State.currentlyFocusedInput();
    const content = scroll?.getInnerViewRef();
    if (!scroll || !field || !content) return;
    field.measureLayout(
      content,
      (_x, y, _width, height) => {
        const needed = y + height + margin - viewport.current;
        if (needed > offset.current) scroll.scrollTo({ y: needed, animated: true });
      },
      () => undefined,
    );
  }, [margin]);

  const onLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const height = event.nativeEvent.layout.height;
      const shrank = height < viewport.current;
      viewport.current = height;
      if (shrank) requestAnimationFrame(reveal);
    },
    [reveal],
  );

  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    offset.current = event.nativeEvent.contentOffset.y;
  }, []);

  return { ref, onLayout, onScroll, scrollEventThrottle: 16 };
}
