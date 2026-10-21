import { Pressable, Text, View } from "react-native";

import { bubbleShadow, continuousCorners, pressedTransform } from "@/theme";

import { cx } from "./cx";
import { useFlag } from "./useFlag";

export type ChoiceCardProps = {
  title: string;
  /** One line under the title; read as the accessibility hint. */
  description: string;
  selected: boolean;
  onPress: () => void;
  /** Layout-only classes (margins). */
  className?: string;
  testID?: string;
};

// A radio drawn as a bubble: the whole card is the target, the green ring and the dot show the
// choice. Group several in a view with `accessibilityRole="radiogroup"`.
const SURFACE_STYLE = [bubbleShadow, continuousCorners];

export function ChoiceCard({
  title,
  description,
  selected,
  onPress,
  className,
  testID,
}: ChoiceCardProps) {
  const [pressed, pressIn, pressOut] = useFlag();

  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: selected }}
      accessibilityLabel={title}
      accessibilityHint={description}
      onPress={onPress}
      onPressIn={pressIn}
      onPressOut={pressOut}
      testID={testID}
      style={pressed ? [...SURFACE_STYLE, pressedTransform] : SURFACE_STYLE}
      className={cx(
        "flex-row items-center gap-4 rounded-lg border-2 bg-white p-4",
        selected ? "border-green-700" : "border-transparent",
        className,
      )}
    >
      <View className="flex-1 gap-1">
        <Text className="text-headline text-navy-900">{title}</Text>
        <Text className="text-callout text-gray-500">{description}</Text>
      </View>
      <View
        testID={testID && `${testID}-indicator`}
        className={cx(
          "h-6 w-6 items-center justify-center rounded-pill border-2",
          selected ? "border-green-700" : "border-gray-500",
        )}
      >
        {selected ? <View className="h-3 w-3 rounded-pill bg-green-700" /> : null}
      </View>
    </Pressable>
  );
}
