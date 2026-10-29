import { Pressable, Text, View } from "react-native";

import { bubbleShadow, continuousCorners, pressedTransform } from "@/theme";

import { cx } from "./cx";
import { useFlag } from "./useFlag";

export type ChoiceCardProps = {
  title: string;
  /** One line under the title, when the choice needs one; read as the accessibility hint. */
  description?: string;
  selected: boolean;
  onPress: () => void;
  /** Not a choice right now: dimmed, takes no presses; the description says why. */
  disabled?: boolean;
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
  disabled = false,
  className,
  testID,
}: ChoiceCardProps) {
  const [pressed, pressIn, pressOut] = useFlag();

  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: selected, disabled }}
      accessibilityLabel={title}
      accessibilityHint={description}
      onPress={onPress}
      disabled={disabled}
      onPressIn={pressIn}
      onPressOut={pressOut}
      testID={testID}
      style={pressed ? [...SURFACE_STYLE, pressedTransform] : SURFACE_STYLE}
      className={cx(
        "flex-row items-center gap-4 rounded-lg border-2 bg-white p-4",
        selected ? "border-green-700" : "border-transparent",
        disabled && "opacity-50",
        className,
      )}
    >
      <View className="flex-1 gap-1">
        <Text className="text-headline text-navy-900">{title}</Text>
        {description ? <Text className="text-callout text-gray-500">{description}</Text> : null}
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
