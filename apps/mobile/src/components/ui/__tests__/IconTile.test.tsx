import { render, screen } from "@testing-library/react-native";
import { StyleSheet } from "react-native";

import { FALLBACK_GLYPH } from "@/components/icons";
import { tokens, withOpacity } from "@/theme";

import { IconTile } from "../IconTile";

const tile = () => screen.getByTestId("tile");
const icon = () => tile().queryAll((node) => node.type === "RNSVGSvgView");

describe("IconTile", () => {
  it.each([
    ["md", 56, 32, tokens.radius.md],
    ["lg", 80, 48, tokens.radius.lg],
  ] as const)(
    "IconTile centers the icon in a squircle of the given size (%s)",
    async (size, side, iconSize, radius) => {
      await render(<IconTile slug="handyman" size={size} testID="tile" />);

      expect(tile().props.className).toContain("items-center justify-center");
      expect(StyleSheet.flatten(tile().props.style)).toMatchObject({
        width: side,
        height: side,
        borderRadius: radius,
        borderCurve: "continuous",
        backgroundColor: withOpacity("green-500", 0.12),
      });
      expect(icon()).toHaveLength(1);
      expect(icon()[0].props).toMatchObject({ width: iconSize, height: iconSize });
    },
  );

  it("defaults to the md tile", async () => {
    await render(<IconTile slug="painting" testID="tile" />);

    expect(StyleSheet.flatten(tile().props.style)).toMatchObject({ width: 56, height: 56 });
  });

  it("an unknown slug shows the generic mark in the same tile, so a grid never shifts or shows a hole", async () => {
    await render(<IconTile slug="plumbing" testID="tile" />);

    expect(StyleSheet.flatten(tile().props.style)).toMatchObject({ width: 56, height: 56 });
    expect(icon()).toHaveLength(1);
    const paths = icon()[0].queryAll((node) => node.type === "RNSVGPath");
    expect(paths.filter((node) => node.props.stroke != null).map((node) => node.props.d)).toEqual(
      FALLBACK_GLYPH.strokes,
    );
  });
});
