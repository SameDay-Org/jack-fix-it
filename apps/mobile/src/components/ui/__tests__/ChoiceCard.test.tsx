import { fireEvent, render, screen } from "@testing-library/react-native";
import { StyleSheet } from "react-native";

import { bubbleShadow } from "@/theme";

import { ChoiceCard } from "../ChoiceCard";

const card = () => screen.getByRole("radio", { name: "I'm a pro" });

describe("ChoiceCard", () => {
  it("is a radio with its checked state, the description as hint, and the green ring when selected", async () => {
    const { rerender } = await render(
      <ChoiceCard
        title="I'm a pro"
        description="Receive requests near you."
        selected={false}
        onPress={jest.fn()}
        testID="pro"
      />,
    );

    expect(card().props.accessibilityState).toMatchObject({ checked: false });
    expect(card().props.accessibilityHint).toBe("Receive requests near you.");
    expect(card().props.className).toContain("border-transparent");
    expect(screen.getByTestId("pro-indicator").props.className).toContain("border-gray-500");

    await rerender(
      <ChoiceCard
        title="I'm a pro"
        description="Receive requests near you."
        selected
        onPress={jest.fn()}
        testID="pro"
      />,
    );

    expect(card().props.accessibilityState).toMatchObject({ checked: true });
    expect(card().props.className).toContain("border-green-700");
    expect(screen.getByTestId("pro-indicator").props.className).toContain("border-green-700");
  });

  it("is a pressable bubble", async () => {
    const onPress = jest.fn();
    await render(
      <ChoiceCard
        title="I'm a pro"
        description="Receive requests."
        selected={false}
        onPress={onPress}
      />,
    );

    await fireEvent.press(card());

    expect(onPress).toHaveBeenCalledTimes(1);
    expect(card().props.className.split(" ")).toEqual(
      expect.arrayContaining(["rounded-lg", "bg-white", "border-2"]),
    );
    expect(StyleSheet.flatten(card().props.style)).toMatchObject({
      ...bubbleShadow,
      borderCurve: "continuous",
    });
  });

  it("leaves the description out when there is none", async () => {
    await render(<ChoiceCard title="One time" selected={false} onPress={jest.fn()} />);

    const oneTime = screen.getByRole("radio", { name: "One time" });
    expect(oneTime.props.accessibilityHint).toBeUndefined();
    expect(screen.getAllByText(/./)).toHaveLength(1); // the title alone
  });

  it("exposes disabled, dims and ignores presses", async () => {
    const onPress = jest.fn();
    await render(
      <ChoiceCard
        title="Mom's"
        description="Not in our area yet."
        selected={false}
        disabled
        onPress={onPress}
      />,
    );

    const moms = screen.getByRole("radio", { name: "Mom's" });
    expect(moms.props.accessibilityState).toMatchObject({ checked: false, disabled: true });
    expect(moms.props.className).toContain("opacity-50");
    await fireEvent.press(moms);
    expect(onPress).not.toHaveBeenCalled();
  });
});
