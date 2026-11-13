import { useEffect, useRef, type ComponentRef, type RefObject } from "react";
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
 * Shows and reads out the first problem of a refused Review or Send. The form scrolls that
 * field's section to its top, and screen-reader focus lands on the control that states the
 * problem, which reads its name, its value and the message (its hint): the one spoken element, on
 * iOS too, where the messages' live regions do not exist.
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

  useEffect(() => {
    if (!refusal) return;
    const { field } = refusal;
    const top = tops.current[field];
    // The scroll content's own top padding is the room left above the section.
    if (top === undefined) awaited.current = field;
    else scrollRef.current?.scrollTo({ y: top, animated: true });
    const controls = { price: priceRef, scope: scopeRef, duration: durationRef, start: startRef };
    moveAccessibilityFocus(controls[field].current);
  }, [refusal, scrollRef]);

  const onSectionLayout =
    (field: QuoteField) =>
    ({ nativeEvent }: LayoutChangeEvent) => {
      tops.current[field] = nativeEvent.layout.y;
      if (awaited.current !== field) return;
      awaited.current = null;
      scrollRef.current?.scrollTo({ y: nativeEvent.layout.y, animated: true });
    };

  return { priceRef, scopeRef, durationRef, startRef, onSectionLayout };
}
