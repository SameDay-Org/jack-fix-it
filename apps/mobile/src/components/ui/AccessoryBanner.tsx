import type { ReactNode } from "react";
import { Pressable, Text, useWindowDimensions, View } from "react-native";

import { ControlIcon } from "@/components/icons";
import { pressedTransform, tokens, withOpacity } from "@/theme";

import { GlassSurface } from "./GlassSurface";
import { accessoryLines } from "./TabBar";
import { useFlag } from "./useFlag";

const CHEVRON = 20;
const DOT = 10;
const RIPPLE_OPACITY = 0.15;
const RIPPLE = { color: withOpacity("white", RIPPLE_OPACITY) };

export type AccessoryBannerProps = {
  /** The sentence: it is cut short first when the line runs out of room. */
  main: string;
  /** What the line ends with (a time, or an action word), never cut. */
  tail?: string | null;
  /** The tail is something to do ("confirm", "compare"): drawn in green. */
  tailIsAction?: boolean;
  /** The whole line as one label (the tail and any count included). */
  accessibilityLabel: string;
  accessibilityHint: string;
  onPress: () => void;
  /** Between the line and the chevron: a small count, say. */
  badge?: ReactNode;
  testID?: string;
};

/**
 * The tabs' one-line banner over the tab bar (its accessory): a dark pill on the controls layer
 * (Liquid Glass where the device draws it) with a green dot, the line and a chevron, the whole pill
 * one button. The sentence gives way first; the tail it ends with always shows. At large text the
 * accessory is two lines tall (`accessoryLines`, #486): the sentence and the tail take a line each,
 * and a sentence with no tail may use both.
 */
export function AccessoryBanner({
  main,
  tail = null,
  tailIsAction = false,
  accessibilityLabel,
  accessibilityHint,
  onPress,
  badge,
  testID,
}: AccessoryBannerProps) {
  const [pressed, pressIn, pressOut] = useFlag();
  const twoLines = accessoryLines(useWindowDimensions().fontScale) === 2;
  const tailClass = `text-callout font-semibold ${tailIsAction ? "text-green-500" : "text-white"}`;
  const tailID = testID && `${testID}-tail`;
  return (
    <GlassSurface tone="dark" shape="pill" interactive className="flex-1 overflow-hidden">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityHint={accessibilityHint}
        onPress={onPress}
        onPressIn={pressIn}
        onPressOut={pressOut}
        android_ripple={RIPPLE}
        // A style, not a `scale-*` class: a transform class that appears on press remounts the view.
        style={pressed ? pressedTransform : undefined}
        className="flex-1 flex-row items-center gap-3 px-5"
        testID={testID}
      >
        <View className="rounded-pill bg-green-500" style={{ width: DOT, height: DOT }} />
        {twoLines ? (
          // Large text: the sentence on its line (both lines when nothing follows), the tail under it.
          <View className="flex-1" testID={testID && `${testID}-lines`}>
            <Text numberOfLines={tail ? 1 : 2} className="text-callout font-semibold text-white">
              {main}
            </Text>
            {tail ? (
              <Text numberOfLines={1} className={tailClass} testID={tailID}>
                {tail}
              </Text>
            ) : null}
          </View>
        ) : (
          // The sentence gives way first; the tail it ends with always shows.
          <View className="flex-1 flex-row">
            <Text numberOfLines={1} className="shrink text-callout font-semibold text-white">
              {main}
            </Text>
            {tail ? (
              <Text numberOfLines={1} className={tailClass} testID={tailID}>
                {` · ${tail}`}
              </Text>
            ) : null}
          </View>
        )}
        {badge}
        <ControlIcon name="chevron" size={CHEVRON} color={tokens.colors.white} />
      </Pressable>
    </GlassSurface>
  );
}
