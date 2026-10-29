import { render, screen } from "@testing-library/react-native";
import { processColor } from "react-native";

import { tokens } from "@/theme";

import { GLYPH_STROKE_WIDTH, GLYPH_VIEW_BOX } from "../glyphs";
import { TabIcon } from "../TabIcon";
import { TAB_GLYPHS, type TabGlyphName } from "../tabGlyphs";

// The icon hides itself from accessibility, so queries for it opt into hidden elements.
const HIDDEN = { includeHiddenElements: true };
const svg = () => screen.getByTestId("icon", HIDDEN);
const paths = () => svg().queryAll((node) => node.type === "RNSVGPath");
const strokes = () => paths().filter((node) => node.props.stroke != null);
const accents = () => paths().filter((node) => node.props.stroke == null);
// LineCap.Round and LineJoin.Round as react-native-svg sends them to the native side.
const ROUND = 1;

const NAMES = Object.keys(TAB_GLYPHS) as TabGlyphName[];
const NAVY = tokens.colors["navy-900"];

describe("TabIcon", () => {
  it("draws the three tab glyphs: home, history (a receipt), account", () => {
    expect(NAMES).toEqual(["home", "history", "account"]);
  });

  it.each(NAMES)(
    "%s keeps the category set's style: 24-unit box, one stroke width, round ends",
    async (name) => {
      await render(<TabIcon name={name} color={NAVY} accent={false} testID="icon" />);

      expect(svg().props).toMatchObject({
        width: 24,
        height: 24,
        vbWidth: GLYPH_VIEW_BOX,
        vbHeight: GLYPH_VIEW_BOX,
      });
      expect(strokes().map((path) => path.props.d)).toEqual(TAB_GLYPHS[name].strokes);
      for (const path of strokes()) {
        expect(path.props).toMatchObject({
          fill: null,
          strokeWidth: GLYPH_STROKE_WIDTH,
          strokeLinecap: ROUND,
          strokeLinejoin: ROUND,
        });
        expect(path.props.stroke.payload).toBe(processColor(NAVY));
      }
    },
  );

  it.each(NAMES)(
    "%s paints its green-500 accent under the strokes only when selected",
    async (name) => {
      await render(<TabIcon name={name} color={NAVY} accent testID="icon" />);

      expect(accents()).toHaveLength(1);
      expect(accents()[0].props.d).toBe(TAB_GLYPHS[name].accent);
      expect(accents()[0].props.fill.payload).toBe(processColor(tokens.colors["green-500"]));
      expect(paths()[0]).toBe(accents()[0]);
    },
  );

  it("an unselected glyph has no accent", async () => {
    await render(
      <TabIcon name="home" color={tokens.colors["gray-500"]} accent={false} testID="icon" />,
    );

    expect(accents()).toHaveLength(0);
    for (const path of strokes()) {
      expect(path.props.stroke.payload).toBe(processColor(tokens.colors["gray-500"]));
    }
  });

  it("size reaches the svg and the drawing is hidden from screen readers", async () => {
    await render(<TabIcon name="account" size={40} color={NAVY} accent testID="icon" />);

    expect(svg().props).toMatchObject({ width: 40, height: 40 });
    expect(screen.queryByTestId("icon")).toBeNull();
    expect(svg().props.importantForAccessibility).toBe("no-hide-descendants");
    expect(svg().props.accessibilityElementsHidden).toBe(true);
  });
});
