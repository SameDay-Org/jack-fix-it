import { risenFromWelcome } from "../panelRoute";

describe("risenFromWelcome", () => {
  it("after the panel rise: no stack motion on Android, the top screen's fade on iOS", () => {
    expect(risenFromWelcome({ from: "welcome" }, "android")).toBe("none");
    expect(risenFromWelcome({ from: "welcome" }, "ios")).toBe("fade");
  });

  it("reached any other way: the platform's default push", () => {
    expect(risenFromWelcome(undefined, "android")).toBe("default");
    expect(risenFromWelcome({}, "ios")).toBe("default");
    expect(risenFromWelcome({ role: "pro" }, "android")).toBe("default");
  });
});
