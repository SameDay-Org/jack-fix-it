import { AccessibilityInfo } from "react-native";

import { moveAccessibilityFocus } from "../focus";

describe("moveAccessibilityFocus", () => {
  it("focuses the node's tag, and nothing when there is no node", () => {
    const focus = jest.spyOn(AccessibilityInfo, "setAccessibilityFocus").mockImplementation();

    moveAccessibilityFocus(42); // a tag passes through findNodeHandle unchanged
    expect(focus).toHaveBeenCalledWith(42);

    moveAccessibilityFocus(null);
    expect(focus).toHaveBeenCalledTimes(1);
    focus.mockRestore();
  });
});
