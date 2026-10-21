import { isGlassEffectAPIAvailable, isLiquidGlassAvailable } from "expo-glass-effect";

import { tokens } from "@/theme";

import { sheetOptions } from "../sheet";

jest.mock("expo-glass-effect", () => ({
  GlassView: () => null,
  isLiquidGlassAvailable: jest.fn(() => false),
  isGlassEffectAPIAvailable: jest.fn(() => false),
}));

describe("sheetOptions", () => {
  it("returns formSheet with grabber, detents and the xl corner radius token", () => {
    expect(sheetOptions([0.5, 0.95])).toEqual({
      presentation: "formSheet",
      sheetAllowedDetents: [0.5, 0.95],
      sheetGrabberVisible: true,
      sheetCornerRadius: tokens.radius.xl,
      headerShown: false,
      contentStyle: { backgroundColor: tokens.colors.white },
    });
    expect(sheetOptions("fitToContents").sheetAllowedDetents).toBe("fitToContents");
  });

  it("leaves the surface to the system where the device draws Liquid Glass", () => {
    jest.mocked(isLiquidGlassAvailable).mockReturnValue(true);
    jest.mocked(isGlassEffectAPIAvailable).mockReturnValue(true);

    expect(sheetOptions("fitToContents").contentStyle).toEqual({ backgroundColor: "transparent" });

    jest.mocked(isGlassEffectAPIAvailable).mockReturnValue(false);
    expect(sheetOptions("fitToContents").contentStyle).toEqual({
      backgroundColor: tokens.colors.white,
    });
  });
});
