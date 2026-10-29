import { useState } from "react";
import { Text, View, type DimensionValue, type TextLayoutEvent } from "react-native";

import { tokens } from "@/theme";

import { cx } from "./cx";
import { Skeleton } from "./Skeleton";

type TypeStyle = keyof typeof tokens.fontSize;

export type TextSkeletonProps = {
  /** The type style of the text it stands for. */
  type: TypeStyle;
  /** The bar's width, for text that keeps to one line. */
  width?: DimensionValue;
  /**
   * Text the placeholder stands in for when its line breaks matter: an invisible copy of it takes
   * the space that text would at this width and font scale, and a bar covers each of its lines.
   */
  sample?: string;
  /** Layout-only classes for the line's box (`shrink` in a wrapping row). */
  className?: string;
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

type TextLine = TextLayoutEvent["nativeEvent"]["lines"][number];

const NO_LINES: readonly TextLine[] = [];

/**
 * A placeholder for text: exactly as tall as that text, because an invisible copy of the same
 * type style sizes it (font scale included, which Android applies non-linearly), with a bar as
 * tall as the type's font size across each line. Loaded text then takes the same space. Without
 * a `sample` it is one line with one bar of `width`; with one, the sample's lines each get a bar
 * where the text laid them out (until then, one bar across the box).
 */
export function TextSkeleton({
  type,
  width = "100%",
  sample,
  className,
  testID,
}: TextSkeletonProps) {
  const [lines, setLines] = useState(NO_LINES);
  const size = tokens.fontSize[type].size;
  const laidOut = sample !== undefined && lines.length > 0;

  return (
    <View className={className} testID={testID}>
      <Text
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        className={cx(TYPE_CLASS[type], "opacity-0")}
        onTextLayout={
          sample === undefined ? undefined : (event) => setLines(event.nativeEvent.lines)
        }
      >
        {sample ?? "\u00A0"}
      </Text>
      {laidOut ? (
        lines.map((line, index) => (
          <View
            key={index}
            className="absolute"
            style={{ left: line.x, top: line.y + (line.height - size) / 2, width: line.width }}
          >
            <Skeleton height={size} />
          </View>
        ))
      ) : (
        <View className="absolute inset-0 justify-center">
          <Skeleton width={width} height={size} />
        </View>
      )}
    </View>
  );
}
