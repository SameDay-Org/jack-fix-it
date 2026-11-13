import { render, screen } from "@testing-library/react-native";
import { Dimensions, Platform, processColor, StyleSheet, Text } from "react-native";

import { VERIFIED_SEAL_PATH } from "@/components/icons";
import { tokens } from "@/theme";

import { VerifiedBadge, verifiedBadgeSize } from "../VerifiedBadge";

// The seal hides itself from accessibility, so queries for it opt into hidden elements.
const HIDDEN = { includeHiddenElements: true };
const seal = () => screen.getByTestId("seal", HIDDEN);
const svgNodes = () =>
  seal().queryAll((node) => typeof node.type === "string" && node.type.startsWith("RNSVG"));
// FillRule.EvenOdd as react-native-svg sends it to the native side (NonZero is 1).
const EVEN_ODD = 0;
const WORD_JOINER = "\u2060";

async function renderName(type: "headline" | "title-1" | "display" = "headline") {
  await render(
    <Text testID="name">
      María P.
      <VerifiedBadge type={type} testID="seal" />
    </Text>,
  );
}

describe("VerifiedBadge", () => {
  let dimensions: jest.SpyInstance;

  const useFontScale = (fontScale: number) => {
    const real = Dimensions.get("window");
    dimensions.mockReturnValue({ ...real, fontScale });
  };

  beforeEach(() => {
    dimensions = jest.spyOn(Dimensions, "get");
  });

  afterEach(() => {
    dimensions.mockRestore();
  });

  it("VerifiedBadge renders one even-odd green-700 path", async () => {
    await renderName();

    // One svg holding one path: no second shape, no stroke, no white anywhere.
    const nodes = svgNodes();
    expect(nodes.map((node) => node.type)).toEqual(["RNSVGSvgView", "RNSVGGroup", "RNSVGPath"]);
    const [path] = seal().queryAll((node) => node.type === "RNSVGPath");
    expect(path.props.d).toBe(VERIFIED_SEAL_PATH);
    expect(path.props.fillRule).toBe(EVEN_ODD);
    expect(path.props.fill.payload).toBe(processColor(tokens.colors["green-700"]));
    expect(path.props.stroke).toBeUndefined();
  });

  it("the path is a rosette and a check inside a 1-unit margin of the 24-unit box", () => {
    const subpaths = VERIFIED_SEAL_PATH.split(/(?=M)/);
    expect(subpaths).toHaveLength(2);
    for (const subpath of subpaths) expect(subpath.endsWith("Z")).toBe(true);

    // Every point of the rosette's cubic segments (end and control points) stays in [1, 23].
    const rosette = subpaths[0].match(/-?\d+(?:\.\d+)?/g)!.map(Number);
    expect(Math.min(...rosette)).toBe(1);
    expect(Math.max(...rosette)).toBe(23);
    // Twelve scallops, two segments each.
    expect(subpaths[0].match(/C/g)).toHaveLength(24);
  });

  it.each([
    [1, 17],
    [1.3, 22],
  ])(
    "VerifiedBadge scales with font scale (%s → %s dp; iOS multiplies)",
    async (fontScale, side) => {
      useFontScale(fontScale);
      await renderName();

      const [svg] = seal().queryAll((node) => node.type === "RNSVGSvgView");
      expect(svg.props).toMatchObject({ bbWidth: side, bbHeight: side });
      // A 4 dp gap before the seal, inside its box, so the name's last letter never touches it.
      expect(StyleSheet.flatten(seal().props.style)).toMatchObject({
        width: side + 4,
        height: side,
        paddingStart: 4,
      });
      expect(verifiedBadgeSize("headline", fontScale)).toBe(side);
    },
  );

  describe("on Android 14 and later, where large text grows less than the font scale", () => {
    const realVersion = Object.getOwnPropertyDescriptor(Platform, "Version");
    let os: jest.ReplaceProperty<typeof Platform.OS>;

    beforeEach(() => {
      os = jest.replaceProperty(Platform, "OS", "android");
      Object.defineProperty(Platform, "Version", { configurable: true, get: () => 35 });
    });

    afterEach(() => {
      os.restore();
      if (realVersion) Object.defineProperty(Platform, "Version", realVersion);
    });

    it.each([
      ["display", 1.3, 34],
      ["display", 2, 42],
      ["headline", 1.3, 21],
      ["headline", 2, 29],
    ] as const)(
      "the %s seal at font scale %s is drawn as tall as the name's letters (%s dp), from its first frame",
      async (type, fontScale, side) => {
        useFontScale(fontScale);
        await renderName(type);

        // The size is computed, not measured: the first render is the final one. (The svg's
        // host view has its own name on Android.)
        const [svg] = seal().queryAll(
          (node) => typeof node.type === "string" && node.type.startsWith("RNSVGSvgView"),
        );
        expect(svg.props).toMatchObject({ bbWidth: side, bbHeight: side });
        expect(StyleSheet.flatten(seal().props.style)).toMatchObject({
          width: side + 4,
          height: side,
          paddingStart: 4,
        });
      },
    );
  });

  it("follows the name's type style", async () => {
    useFontScale(1);
    await renderName("title-1");

    expect(StyleSheet.flatten(seal().props.style)).toMatchObject({ height: 28 });
  });

  it("is glued to the name's last word and hidden from screen readers", async () => {
    await renderName();

    // A word joiner between the name and the seal: no line break can separate them.
    const name = screen.getByTestId("name");
    expect(name.props.children[0]).toBe("María P.");
    expect(name.children).toContain(WORD_JOINER);
    expect(screen.queryByTestId("seal")).toBeNull();
    expect(seal().props.importantForAccessibility).toBe("no-hide-descendants");
    expect(seal().props.accessibilityElementsHidden).toBe(true);
  });
});
