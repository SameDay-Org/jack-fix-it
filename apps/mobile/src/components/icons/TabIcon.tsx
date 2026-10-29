import Svg, { Path } from "react-native-svg";

import { tokens } from "@/theme";

import { GLYPH_STROKE_WIDTH, GLYPH_VIEW_BOX } from "./glyphs";
import { TAB_GLYPHS, type TabGlyphName } from "./tabGlyphs";

export type TabIconProps = {
  name: TabGlyphName;
  /** Width and height in dp; the glyphs are drawn to read at 24. */
  size?: number;
  /** The stroke color. */
  color: string;
  /** Paints the green-500 accent under the strokes: the selected tab. */
  accent: boolean;
  testID?: string;
};

const DEFAULT_SIZE = 24;

/**
 * A tab's flat glyph. Decorative: the tab around it carries the label and the selected state, so
 * the drawing is hidden from screen readers on both platforms. Its size is in dp and never follows
 * the font scale.
 */
export function TabIcon({ name, size = DEFAULT_SIZE, color, accent, testID }: TabIconProps) {
  const glyph = TAB_GLYPHS[name];

  return (
    <Svg
      width={size}
      height={size}
      viewBox={`0 0 ${GLYPH_VIEW_BOX} ${GLYPH_VIEW_BOX}`}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      testID={testID}
    >
      {accent ? <Path d={glyph.accent} fill={tokens.colors["green-500"]} /> : null}
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
