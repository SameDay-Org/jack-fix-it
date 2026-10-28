import Svg, { Path } from "react-native-svg";

import { tokens } from "@/theme";

import { GLYPH_STROKE_WIDTH, GLYPH_VIEW_BOX, glyphFor } from "./glyphs";

export type CategoryIconProps = {
  /** The category slug; a slug without a glyph renders nothing. */
  slug: string;
  /** Width and height in dp. The set is drawn to read at 32 and 48. */
  size?: number;
  /** The stroke color; navy-900 by default. The accent stays green-500. */
  color?: string;
  testID?: string;
};

const DEFAULT_SIZE = 32;

/**
 * A category's flat glyph. Decorative: hidden from screen readers on both platforms, because the
 * card around it carries the category name. Its size is in dp and never follows the font scale.
 */
export function CategoryIcon({
  slug,
  size = DEFAULT_SIZE,
  color = tokens.colors["navy-900"],
  testID,
}: CategoryIconProps) {
  const glyph = glyphFor(slug);
  if (!glyph) return null;

  return (
    <Svg
      width={size}
      height={size}
      viewBox={`0 0 ${GLYPH_VIEW_BOX} ${GLYPH_VIEW_BOX}`}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      testID={testID}
    >
      {glyph.accent ? <Path d={glyph.accent} fill={tokens.colors["green-500"]} /> : null}
      {glyph.strokes.map((d) => (
        <Path
          key={d}
          d={d}
          fill="none"
          stroke={color}
          strokeWidth={GLYPH_STROKE_WIDTH}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </Svg>
  );
}
