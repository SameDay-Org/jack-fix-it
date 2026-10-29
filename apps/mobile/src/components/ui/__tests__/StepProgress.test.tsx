import { render, screen } from "@testing-library/react-native";

import { StepProgress } from "../StepProgress";

describe("StepProgress", () => {
  it("is one progress bar named by its label, with one segment per step filled up to the current", async () => {
    await render(<StepProgress current={2} total={5} label="Step 2 of 5" testID="progress" />);

    const bar = screen.getByRole("progressbar", { name: "Step 2 of 5" });
    expect(bar.props.accessibilityValue).toEqual({ min: 0, max: 5, now: 2 });
    expect(bar.props.accessible).toBe(true);
    expect(screen.getByText("Step 2 of 5")).toBeTruthy();
    const segments = [1, 2, 3, 4, 5].map((n) => screen.getByTestId(`progress-segment-${n}`));
    expect(segments.map((segment) => segment.props.className.includes("bg-green-700"))).toEqual([
      true,
      true,
      false,
      false,
      false,
    ]);
  });

  it("fills every segment on the last step", async () => {
    await render(<StepProgress current={4} total={4} label="Step 4 of 4" testID="progress" />);

    for (const n of [1, 2, 3, 4]) {
      expect(screen.getByTestId(`progress-segment-${n}`).props.className).toContain("bg-green-700");
    }
  });
});
