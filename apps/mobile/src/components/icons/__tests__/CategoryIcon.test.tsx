import { render, screen } from "@testing-library/react-native";
import { processColor } from "react-native";

import { tokens } from "@/theme";

import { CategoryIcon } from "../CategoryIcon";
import { CATEGORY_GLYPHS, GLYPH_STROKE_WIDTH } from "../glyphs";

// The launch categories, in display order. Keep in step with
// apps/api/app/modules/categories/seed_data.json: a new seeded slug needs a glyph.
const SEED_SLUGS = [
  "house-cleaning",
  "handyman",
  "painting",
  "lawn-landscaping",
  "moving-assembly",
] as const;

// The icon hides itself from accessibility, so queries for it opt into hidden elements.
const HIDDEN = { includeHiddenElements: true };
const svg = () => screen.getByTestId("icon", HIDDEN);
const paths = () => svg().queryAll((node) => node.type === "RNSVGPath");
const strokes = () => paths().filter((node) => node.props.stroke != null);
const accents = () => paths().filter((node) => node.props.stroke == null);
// LineCap.Round and LineJoin.Round as react-native-svg sends them to the native side.
const ROUND = 1;

describe("CategoryIcon", () => {
  it("every seeded category slug has an icon", async () => {
    expect(Object.keys(CATEGORY_GLYPHS).sort()).toEqual([...SEED_SLUGS].sort());

    for (const slug of SEED_SLUGS) {
      await render(<CategoryIcon slug={slug} testID="icon" />);
      expect(strokes().length).toBeGreaterThan(0);
    }
  });

  it.each(["plumbing", "", "constructor", "toString"])(
    "an unknown slug renders nothing (%j)",
    async (slug) => {
      await render(<CategoryIcon slug={slug} testID="icon" />);

      expect(screen.toJSON()).toBeNull();
    },
  );

  it("the icon is hidden from screen readers", async () => {
    await render(<CategoryIcon slug="painting" testID="icon" />);

    expect(screen.queryByTestId("icon")).toBeNull();
    expect(svg().props.importantForAccessibility).toBe("no-hide-descendants");
    expect(svg().props.accessibilityElementsHidden).toBe(true);
  });

  it("size and color reach the svg", async () => {
    await render(
      <CategoryIcon slug="painting" size={48} color={tokens.colors.white} testID="icon" />,
    );

    expect(svg().props).toMatchObject({ width: 48, height: 48 });
    for (const path of strokes()) {
      expect(path.props.stroke.payload).toBe(processColor(tokens.colors.white));
    }
  });

  it("defaults to 32 dp in navy-900", async () => {
    await render(<CategoryIcon slug="painting" testID="icon" />);

    expect(svg().props).toMatchObject({ width: 32, height: 32, vbWidth: 24, vbHeight: 24 });
    for (const path of strokes()) {
      expect(path.props.stroke.payload).toBe(processColor(tokens.colors["navy-900"]));
    }
  });

  it.each(SEED_SLUGS)(
    "%s keeps the set's style: one stroke width, round ends, one green-500 accent",
    async (slug) => {
      await render(<CategoryIcon slug={slug} color={tokens.colors.white} testID="icon" />);

      for (const path of strokes()) {
        expect(path.props).toMatchObject({
          fill: null,
          strokeWidth: GLYPH_STROKE_WIDTH,
          strokeLinecap: ROUND,
          strokeLinejoin: ROUND,
        });
      }
      expect(accents()).toHaveLength(1);
      for (const path of accents()) {
        // The color prop never repaints the accent.
        expect(path.props.fill.payload).toBe(processColor(tokens.colors["green-500"]));
      }
    },
  );
});
