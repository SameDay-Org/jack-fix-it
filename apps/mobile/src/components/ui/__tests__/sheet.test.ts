import { tokens } from "@/theme";

import { sheetOptions } from "../sheet";

describe("sheetOptions", () => {
  it("returns formSheet with grabber, detents and the xl corner radius token", () => {
    expect(sheetOptions([0.5, 0.95])).toEqual({
      presentation: "formSheet",
      sheetAllowedDetents: [0.5, 0.95],
      sheetGrabberVisible: true,
      sheetCornerRadius: tokens.radius.xl,
      headerShown: false,
      contentStyle: { backgroundColor: "transparent" },
    });
    expect(sheetOptions("fitToContents").sheetAllowedDetents).toBe("fitToContents");
  });
});
