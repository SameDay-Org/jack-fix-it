import { fireEvent, render, screen } from "@testing-library/react-native";
import { Dimensions, StyleSheet, Text } from "react-native";

import { pressedTransform } from "@/theme";

import { AccessoryBanner } from "../AccessoryBanner";

const banner = () => screen.getByRole("button", { name: "Quote ready · compare" });

/** The system font scale the banner reads (`useWindowDimensions`). */
function setFontScale(fontScale: number) {
  const real = Dimensions.get("window");
  jest.spyOn(Dimensions, "get").mockReturnValue({ ...real, fontScale });
}

beforeEach(() => {
  // One line: below the accessory's two-line scale (Jest's own default is 2).
  jest.restoreAllMocks();
  setFontScale(1);
});

afterAll(() => jest.restoreAllMocks());

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

  // #486: the accessory is two lines tall at large text, so the line takes both.
  it("at large text puts the sentence and the tail on a line each, and lets a lone sentence wrap", async () => {
    setFontScale(2);
    const { rerender } = await render(
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
    // Still one button read as one line.
    expect(banner()).toBeTruthy();
    expect(screen.getByTestId("banner-lines")).toBeTruthy();
    expect(screen.getByText("Quote ready").props.numberOfLines).toBe(1);
    const tail = screen.getByTestId("banner-tail");
    expect(tail.props.children).toBe("compare");
    expect(tail.props.numberOfLines).toBe(1);
    expect(tail.props.className).toContain("text-green-500");

    await rerender(
      <AccessoryBanner
        main="Jack is finding a pro for your request"
        accessibilityLabel="Jack is finding a pro for your request"
        accessibilityHint="Opens your request"
        onPress={jest.fn()}
        testID="banner"
      />,
    );
    expect(screen.getByText("Jack is finding a pro for your request").props.numberOfLines).toBe(2);
    expect(screen.queryByTestId("banner-tail")).toBeNull();
  });

  it("keeps one line below the large-text scale", async () => {
    setFontScale(1.3);
    await render(
      <AccessoryBanner
        main="Quote ready"
        tail="compare"
        accessibilityLabel="Quote ready · compare"
        accessibilityHint="Opens your request"
        onPress={jest.fn()}
        testID="banner"
      />,
    );
    expect(screen.queryByTestId("banner-lines")).toBeNull();
    expect(screen.getByTestId("banner-tail").props.children).toBe(" · compare");
  });
});
