import { render, screen } from "@testing-library/react-native";
import { StyleSheet, Text } from "react-native";

import { bubbleShadow } from "@/theme";

import { ChatBubble, type ChatBubbleSide } from "../ChatBubble";

// The tail hides itself from accessibility, so queries for it opt into hidden elements.
const HIDDEN = { includeHiddenElements: true };
const TEXT = "See you at nine";

async function renderBubble(side: ChatBubbleSide, tail: boolean, faded?: boolean) {
  await render(
    <ChatBubble side={side} tail={tail} faded={faded} testID="bubble">
      <Text>{TEXT}</Text>
    </ChatBubble>,
  );
}

type Host = ReturnType<typeof screen.getByTestId>;
const styleOf = (node: Host) => StyleSheet.flatten(node.props.style) ?? {};

/** The outer host: carries the fade. */
const outerStyle = () => styleOf(screen.getByTestId("bubble"));

/** The surface around the caller's text: carries the corners and the shadow. */
const surfaceStyle = () => {
  const surface = screen.getByText(TEXT).parent;
  if (!surface) throw new Error("the text has no surface around it");
  return styleOf(surface);
};

describe("ChatBubble", () => {
  it("renders its children", async () => {
    await renderBubble("theirs", false);

    expect(screen.getByText(TEXT)).toBeTruthy();
  });

  it.each([
    ["mine", "borderBottomRightRadius", "borderBottomLeftRadius"],
    ["theirs", "borderBottomLeftRadius", "borderBottomRightRadius"],
  ] as const)(
    "%s: the tail squares the speaker-side bottom corner and draws there",
    async (side, squared, round) => {
      await renderBubble(side, true);

      const tail = screen.getByTestId("bubble-tail", HIDDEN);
      expect(tail).toBeTruthy();
      expect(surfaceStyle()[squared]).toBe(0);
      expect(surfaceStyle()[round]).toBeUndefined();
      const tailStyle = styleOf(tail);
      expect(tailStyle.position).toBe("absolute");
      expect(tailStyle.bottom).toBe(0);
      if (side === "mine") expect(tailStyle.right).toBeLessThan(0);
      else expect(tailStyle.left).toBeLessThan(0);
    },
  );

  it.each(["mine", "theirs"] as const)(
    "%s without a tail: no tail and every corner round",
    async (side) => {
      await renderBubble(side, false);

      expect(screen.queryByTestId("bubble-tail", HIDDEN)).toBeNull();
      expect(surfaceStyle().borderBottomRightRadius).toBeUndefined();
      expect(surfaceStyle().borderBottomLeftRadius).toBeUndefined();
    },
  );

  it("theirs carries the bubble shadow", async () => {
    await renderBubble("theirs", true);

    expect(surfaceStyle()).toMatchObject(bubbleShadow);
    expect(surfaceStyle().elevation).toBe(bubbleShadow.elevation);
  });

  it("mine carries no shadow", async () => {
    await renderBubble("mine", true);

    expect(surfaceStyle().elevation).toBeUndefined();
    expect(surfaceStyle().shadowOpacity).toBeUndefined();
    expect(surfaceStyle().shadowColor).toBeUndefined();
  });

  it("faded dims the whole bubble to 0.6", async () => {
    await renderBubble("mine", true, true);

    expect(outerStyle().opacity).toBe(0.6);
  });

  it("not faded, the bubble is fully opaque", async () => {
    await renderBubble("mine", true);

    expect(outerStyle().opacity).toBeUndefined();
  });

  it("the tail is hidden from accessibility", async () => {
    await renderBubble("theirs", true);

    expect(screen.queryByTestId("bubble-tail")).toBeNull();
    const tail = screen.getByTestId("bubble-tail", HIDDEN);
    expect(tail.props.accessibilityElementsHidden).toBe(true);
    expect(tail.props.importantForAccessibility).toBe("no-hide-descendants");
  });
});
