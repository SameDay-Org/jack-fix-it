import { fireEvent, render, screen } from "@testing-library/react-native";
import { StyleSheet, Text } from "react-native";

import { bubbleShadow, pressedTransform } from "@/theme";

import { Card } from "../Card";

describe("Card", () => {
  it("renders as a pressable button with label when onPress is set", async () => {
    const onPress = jest.fn();
    await render(
      <Card onPress={onPress} accessibilityLabel="Open job">
        <Text>Job</Text>
      </Card>,
    );

    await fireEvent.press(screen.getByRole("button", { name: "Open job" }));

    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("renders as a plain view without onPress", async () => {
    await render(
      <Card>
        <Text>Job</Text>
      </Card>,
    );

    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Job")).toBeTruthy();
  });

  it("is a white bubble with the shared shadow and continuous corners", async () => {
    await render(
      <Card testID="card">
        <Text>Job</Text>
      </Card>,
    );
    const card = screen.getByTestId("card");

    expect(card.props.className).toContain("rounded-lg bg-white p-4");
    expect(card.props.className).not.toMatch(/\bborder/);
    expect(StyleSheet.flatten(card.props.style)).toMatchObject({
      ...bubbleShadow,
      borderCurve: "continuous",
    });
  });

  it("shrinks while pressed instead of changing color", async () => {
    await render(
      <Card onPress={jest.fn()} accessibilityLabel="Open job">
        <Text>Job</Text>
      </Card>,
    );
    const card = () => screen.getByRole("button", { name: "Open job" });

    await fireEvent(card(), "pressIn");
    expect(StyleSheet.flatten(card().props.style)).toMatchObject(pressedTransform);
    expect(card().props.className).toContain("bg-white");

    await fireEvent(card(), "pressOut");
    expect(StyleSheet.flatten(card().props.style).transform).toBeUndefined();
  });
});
