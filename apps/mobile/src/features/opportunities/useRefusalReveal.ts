import { useCallback, useEffect, useRef, type ComponentRef, type RefObject } from "react";
import type { LayoutChangeEvent, ScrollView, View } from "react-native";

import { moveAccessibilityFocus, type InputHandle } from "@/components/ui";

import type { QuoteField } from "./quoteDraft";

/**
 * A Review or a Send the form refused; `field` is the first one it marked. A new object each
 * time, so a second refusal over the same field shows it again.
 */
export type Refusal = { field: QuoteField };

type FormScroll = RefObject<ComponentRef<typeof ScrollView> | null>;

/**
 * How long a programmatic scroll takes to land, near enough, on either platform. Screen-reader
 * focus is sent after it: TalkBack takes focus only on a control that is on screen.
 */
export const REVEAL_SETTLE_MS = 400;

/**
 * Shows and reads out the first problem of a refused Review or Send. The form scrolls that
 * field's section to its top; once the scroll has landed, screen-reader focus goes to the control
 * that states the problem, which reads its name, its value and the message (its hint). On iOS,
 * which has no live regions, that hint is how the message is heard.
 *
 * Put `onSectionLayout(field)` on each field's section, a direct child of the form's root, and
 * each ref on the control that states that field's problem.
 */
export function useRefusalReveal(refusal: Refusal | undefined, scrollRef: FormScroll) {
  const priceRef = useRef<InputHandle>(null);
  const scopeRef = useRef<InputHandle>(null);
  const durationRef = useRef<ComponentRef<typeof View>>(null);
  const startRef = useRef<ComponentRef<typeof View>>(null);
  const tops = useRef<Partial<Record<QuoteField, number>>>({});
  // The section to scroll to once it is laid out: a refused Send mounts the form anew.
  const awaited = useRef<QuoteField | null>(null);
  const settling = useRef<ReturnType<typeof setTimeout>>(undefined);

  const reveal = useCallback(
    (field: QuoteField, top: number) => {
      // The scroll content's own top padding is the room left above the section.
      scrollRef.current?.scrollTo({ y: top, animated: true });
      clearTimeout(settling.current);
      settling.current = setTimeout(() => {
        const controls = {
          price: priceRef,
          scope: scopeRef,
          duration: durationRef,
          start: startRef,
        };
        moveAccessibilityFocus(controls[field].current);
      }, REVEAL_SETTLE_MS);
    },
    [scrollRef],
  );

  useEffect(() => () => clearTimeout(settling.current), []);

  useEffect(() => {
    if (!refusal) return;
    const top = tops.current[refusal.field];
    if (top === undefined) awaited.current = refusal.field;
    else reveal(refusal.field, top);
  }, [refusal, reveal]);

  const onSectionLayout =
    (field: QuoteField) =>
    ({ nativeEvent }: LayoutChangeEvent) => {
      tops.current[field] = nativeEvent.layout.y;
      if (awaited.current !== field) return;
      awaited.current = null;
      reveal(field, nativeEvent.layout.y);
    };

  return { priceRef, scopeRef, durationRef, startRef, onSectionLayout };
}
