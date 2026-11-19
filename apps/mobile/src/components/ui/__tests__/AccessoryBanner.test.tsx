import { fireEvent, render, screen } from "@testing-library/react-native";
import { StyleSheet, Text } from "react-native";

import { pressedTransform } from "@/theme";

import { AccessoryBanner } from "../AccessoryBanner";

const banner = () => screen.getByRole("button", { name: "Quote ready · compare" });

describe("AccessoryBanner", () => {
  it("is one button: the line as its label, the hint, the sentence on one line that may shrink", async () => {
    await render(
      <AccessoryBanner
        main="Quote ready"
        tail="compare"
        tailIsAction
        accessibilityLabel="Quote ready · compare"
        accessibilityHint="Opens your request"
        onPress={jest.fn()}
        testID="banner"
      />,
    );

    expect(banner().props.accessibilityHint).toBe("Opens your request");
    const main = screen.getByText("Quote ready");
    expect(main.props.numberOfLines).toBe(1);
    expect(main.props.className).toContain("shrink");
    const tail = screen.getByTestId("banner-tail");
    expect(tail.props.children).toBe(" · compare");
    expect(tail.props.numberOfLines).toBe(1);
    expect(tail.props.className).toContain("text-green-500");
  });

  it("a tail that is not an action stays white; no tail, no separator", async () => {
    const { rerender } = await render(
      <AccessoryBanner
        main="Dan is on the way"
        tail="12 min"
        accessibilityLabel="Dan is on the way · 12 min"
        accessibilityHint="Opens your job"
        onPress={jest.fn()}
        testID="banner"
      />,
    );
    expect(screen.getByTestId("banner-tail").props.className).toContain("text-white");

    await rerender(
      <AccessoryBanner
        main="Jack is finding a pro"
        accessibilityLabel="Jack is finding a pro"
        accessibilityHint="Opens your request"
        onPress={jest.fn()}
        testID="banner"
      />,
    );
    expect(screen.queryByTestId("banner-tail")).toBeNull();
    expect(screen.queryByText(/·/)).toBeNull();
  });

  it("calls onPress, shrinks while pressed and draws the badge it is given", async () => {
    const onPress = jest.fn();
    await render(
      <AccessoryBanner
        main="Quote ready"
        tail="compare"
        tailIsAction
        accessibilityLabel="Quote ready · compare"
        accessibilityHint="Opens your request"
        onPress={onPress}
        badge={<Text testID="badge">3</Text>}
      />,
    );

    expect(screen.getByTestId("badge")).toBeTruthy();
    await fireEvent(banner(), "pressIn");
    expect(StyleSheet.flatten(banner().props.style)).toMatchObject(pressedTransform);
    await fireEvent(banner(), "pressOut");
    await fireEvent.press(banner());
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
