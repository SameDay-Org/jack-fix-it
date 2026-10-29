import { fireEvent, render, screen } from "@testing-library/react-native";

import { Stepper, type StepperProps } from "../Stepper";

const renderStepper = (props: Partial<StepperProps> = {}) =>
  render(
    <Stepper
      label="Hours"
      valueText="2 h"
      onDecrement={jest.fn()}
      onIncrement={jest.fn()}
      decrementLabel="One hour less"
      incrementLabel="One hour more"
      testID="hours"
      {...props}
    />,
  );

describe("Stepper", () => {
  it("is one adjustable control named by its label and reading its value", async () => {
    await renderStepper();
    const control = screen.getByRole("adjustable", { name: "Hours" });
    expect(control.props.accessibilityValue).toEqual({ text: "2 h" });
    expect(control.props.accessibilityActions).toEqual([
      { name: "decrement", label: "One hour less" },
      { name: "increment", label: "One hour more" },
    ]);
  });

  it("steps by touch and by the screen reader's actions, never past a bound", async () => {
    const onDecrement = jest.fn();
    const onIncrement = jest.fn();
    await renderStepper({ onDecrement, onIncrement, canDecrement: false });
    const control = screen.getByTestId("hours");
    const act = (actionName: string) =>
      fireEvent(control, "accessibilityAction", { nativeEvent: { actionName } });

    await fireEvent.press(screen.getByTestId("hours-increment"));
    await act("increment");
    expect(onIncrement).toHaveBeenCalledTimes(2);

    await fireEvent.press(screen.getByTestId("hours-decrement"));
    await act("decrement");
    expect(onDecrement).not.toHaveBeenCalled();
    expect(screen.getByTestId("hours-decrement")).toBeDisabled();
  });

  it("shows its error and hints it to screen readers", async () => {
    await renderStepper({ error: "Add how long the job takes." });
    expect(screen.getByText("Add how long the job takes.")).toBeTruthy();
    expect(screen.getByTestId("hours").props.accessibilityHint).toBe("Add how long the job takes.");
  });
});
