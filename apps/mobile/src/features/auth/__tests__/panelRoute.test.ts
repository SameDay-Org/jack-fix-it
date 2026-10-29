import { tokens } from "@/theme";

import { panelRiseOptions, pushesUnderRise, risenFromWelcome } from "../panelRoute";

describe("risenFromWelcome", () => {
  it("Android: a transparent modal with no stack motion, so Welcome keeps painting under it", () => {
    expect(risenFromWelcome({ from: "welcome" }, "android")).toEqual({
      animation: "none",
      presentation: "transparentModal",
    });
    expect(pushesUnderRise("android")).toBe(true);
  });

  it("iOS: the top screen's fade, pushed when the rise ends, so the edge swipe keeps working", () => {
    expect(risenFromWelcome({ from: "welcome" }, "ios")).toEqual({
      animation: "fade",
      // The card is the panel's page color, so its fades never show the navigator's own gray.
      contentStyle: { backgroundColor: tokens.colors["gray-50"] },
    });
    expect(pushesUnderRise("ios")).toBe(false);
  });

  it("reached any other way: the platform's default push", () => {
    expect(risenFromWelcome(undefined, "android")).toEqual({ animation: "default" });
    expect(risenFromWelcome({}, "ios")).toEqual({ animation: "default" });
    expect(risenFromWelcome({ role: "pro" }, "android")).toEqual({ animation: "default" });
  });
});

describe("panelRiseOptions", () => {
  it("is what any panel rise gives the screen it opens (Home's into the request flow too)", () => {
    expect(panelRiseOptions("android")).toEqual(risenFromWelcome({ from: "welcome" }, "android"));
    expect(panelRiseOptions("ios")).toEqual(risenFromWelcome({ from: "welcome" }, "ios"));
  });
});
