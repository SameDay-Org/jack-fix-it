// Dev-only sample for the gallery (src/app/dev/components.tsx); the strings are literal on purpose.
import type { ComponentRef, RefObject } from "react";
import { ScrollView, View } from "react-native";
import { useReducedMotion } from "react-native-reanimated";

import { Button, GlassSurface } from "@/components/ui";

export type FloatingBarProps = {
  /** The gallery's scroll view, driven by the two actions. */
  scrollRef: RefObject<ComponentRef<typeof ScrollView> | null>;
};

/**
 * The controls layer for real (ADR 0008): a pill glass surface pinned above the bottom safe area,
 * over the scrolling content, holding two ghost actions. Its scrolls animate only when the system
 * does not ask for reduced motion.
 */
export function FloatingBar({ scrollRef }: FloatingBarProps) {
  const reduceMotion = useReducedMotion();
  const animated = !reduceMotion;

  return (
    <View className="absolute inset-x-4 bottom-4">
      <GlassSurface
        tone="light"
        shape="pill"
        interactive
        className="flex-row items-center justify-center gap-2 px-2 py-1"
      >
        <Button
          label="Top"
          variant="ghost"
          onPress={() => scrollRef.current?.scrollTo({ y: 0, animated })}
        />
        <Button
          label="End"
          variant="ghost"
          onPress={() => scrollRef.current?.scrollToEnd({ animated })}
        />
      </GlassSurface>
    </View>
  );
}
