import { fireEvent, render, screen } from "@testing-library/react-native";
import { useReducedMotion } from "react-native-reanimated";

import "@/i18n";

import { FloatingBar } from "../FloatingBar";

jest.mock("react-native-reanimated", () => {
  const actual =
    jest.requireActual<typeof import("react-native-reanimated")>("react-native-reanimated");
  return { __esModule: true, ...actual, useReducedMotion: jest.fn(() => false) };
});

const scrollTo = jest.fn();
const scrollToEnd = jest.fn();
const scrollRef = { current: { scrollTo, scrollToEnd } } as unknown as Parameters<
  typeof FloatingBar
>[0]["scrollRef"];

describe("FloatingBar", () => {
  beforeEach(() => {
    scrollTo.mockClear();
    scrollToEnd.mockClear();
  });

  it.each([
    [false, true],
    [true, false],
  ])("reduce motion %s: Top and End scroll with animated %s", async (reduceMotion, animated) => {
    jest.mocked(useReducedMotion).mockReturnValue(reduceMotion);
    await render(<FloatingBar scrollRef={scrollRef} />);

    await fireEvent.press(screen.getByRole("button", { name: "Top" }));
    await fireEvent.press(screen.getByRole("button", { name: "End" }));

    expect(scrollTo).toHaveBeenCalledWith({ y: 0, animated });
    expect(scrollToEnd).toHaveBeenCalledWith({ animated });
  });

  it("is a light interactive pill with two ghost actions", async () => {
    await render(<FloatingBar scrollRef={scrollRef} />);

    expect(screen.getByRole("button", { name: "Top" }).props.className).not.toContain("bg-");
    expect(screen.getByRole("button", { name: "End" }).props.className).toContain("rounded-pill");
  });
});
