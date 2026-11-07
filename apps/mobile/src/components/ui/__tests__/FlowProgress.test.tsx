import { render, screen } from "@testing-library/react-native";
import { useReducedMotion, withSpring } from "react-native-reanimated";

import { FlowProgress } from "../FlowProgress";

jest.mock("react-native-reanimated", () => {
  const actual =
    jest.requireActual<typeof import("react-native-reanimated")>("react-native-reanimated");
  return {
    __esModule: true,
    ...actual,
    useReducedMotion: jest.fn(() => false),
    withSpring: jest.fn(actual.withSpring),
  };
});

const bar = () => screen.getByRole("progressbar", { name: "Step 2 of 3" });

beforeEach(() => {
  jest.mocked(useReducedMotion).mockReturnValue(false);
  jest.mocked(withSpring).mockClear();
});

describe("FlowProgress", () => {
  it("is one progress bar, named, valued in steps", async () => {
    await render(<FlowProgress completed={1} total={3} label="Step 2 of 3" testID="progress" />);

    expect(bar().props.accessibilityValue).toEqual({ min: 0, max: 3, now: 1 });
    // The groove and the fill are drawing, not content.
    expect(screen.getAllByRole("progressbar")).toHaveLength(1);
  });

  it.each([
    [-1, 0],
    [7, 3],
  ])("clamps %d steps to %d", async (completed, now) => {
    await render(<FlowProgress completed={completed} total={3} label="Step 2 of 3" />);

    expect(bar().props.accessibilityValue.now).toBe(now);
  });

  it("springs to a new step, and moves at once under Reduce Motion", async () => {
    const view = await render(<FlowProgress completed={0} total={3} label="Step 2 of 3" />);
    jest.mocked(withSpring).mockClear();

    await view.rerender(<FlowProgress completed={1} total={3} label="Step 2 of 3" />);
    expect(withSpring).toHaveBeenCalledWith(1 / 3, expect.any(Object));

    jest.mocked(useReducedMotion).mockReturnValue(true);
    jest.mocked(withSpring).mockClear();
    await view.rerender(<FlowProgress completed={2} total={3} label="Step 2 of 3" />);
    expect(withSpring).not.toHaveBeenCalled();
  });
});
