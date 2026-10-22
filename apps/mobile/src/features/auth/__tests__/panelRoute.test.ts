import { risenFromWelcome } from "../panelRoute";

describe("risenFromWelcome", () => {
  it("after the panel rise: no stack motion on Android, the top screen's fade on iOS", () => {
    expect(risenFromWelcome({ from: "welcome" }, "android", false)).toBe("none");
    expect(risenFromWelcome({ from: "welcome" }, "ios", false)).toBe("fade");
  });

  it("under Reduce Motion (no rise): the stack's crossfade on both platforms", () => {
    expect(risenFromWelcome({ from: "welcome" }, "android", true)).toBe("fade");
    expect(risenFromWelcome({ from: "welcome" }, "ios", true)).toBe("fade");
  });

  it("reached any other way: the platform's default push", () => {
    expect(risenFromWelcome(undefined, "android", false)).toBe("default");
    expect(risenFromWelcome({}, "ios", true)).toBe("default");
    expect(risenFromWelcome({ role: "pro" }, "android", false)).toBe("default");
  });
});
