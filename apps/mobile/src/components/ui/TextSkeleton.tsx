import { Text, View, type DimensionValue } from "react-native";

import { tokens } from "@/theme";

import { cx } from "./cx";
import { Skeleton } from "./Skeleton";

type TypeStyle = keyof typeof tokens.fontSize;

export type TextSkeletonProps = {
  /** The type style of the text it stands for. */
  type: TypeStyle;
  width?: DimensionValue;
  testID?: string;
};

// Literal class names, so Tailwind generates each one.
const TYPE_CLASS: Record<TypeStyle, string> = {
  display: "text-display",
  "title-1": "text-title-1",
  "title-2": "text-title-2",
  headline: "text-headline",
  body: "text-body",
  callout: "text-callout",
  footnote: "text-footnote",
  caption: "text-caption",
};

/**
 * A placeholder for one line of text: exactly as tall as that line, because an invisible line of
 * the same type style sizes it (font scale included, which Android applies non-linearly), with
 * a bar as tall as the type's font size across it. Loaded text then takes the same space.
 */
export function TextSkeleton({ type, width = "100%", testID }: TextSkeletonProps) {
  return (
    <View testID={testID}>
      <Text
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        className={cx(TYPE_CLASS[type], "opacity-0")}
      >
        {"\u00A0"}
      </Text>
      <View className="absolute inset-0 justify-center">
        <Skeleton width={width} height={tokens.fontSize[type].size} />
      </View>
    </View>
  );
}
