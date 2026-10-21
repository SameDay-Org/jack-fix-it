import { render, screen } from "@testing-library/react-native";
import { useReducedMotion, withRepeat } from "react-native-reanimated";

import "@/i18n";

import { Skeleton } from "../Skeleton";

jest.mock("react-native-reanimated", () => {
  const actual =
    jest.requireActual<typeof import("react-native-reanimated")>("react-native-reanimated");
  return {
    __esModule: true,
    ...actual,
    useReducedMotion: jest.fn(() => false),
    withRepeat: jest.fn(actual.withRepeat),
  };
});

const placeholderClasses = () =>
  screen.getByRole("progressbar").queryAll((node) => node.type === "View")[0].props.className;

describe("Skeleton", () => {
  beforeEach(() => {
    jest.mocked(useReducedMotion).mockReturnValue(false);
    jest.mocked(withRepeat).mockClear();
  });

  it("has progressbar role and the translated loading label", async () => {
    await render(<Skeleton />);

    const placeholder = screen.getByRole("progressbar");
    expect(placeholder.props.accessibilityLabel).toBe("Loading");
    expect(withRepeat).toHaveBeenCalledTimes(1);
  });

  it("renders without animation when reduced motion is on", async () => {
    jest.mocked(useReducedMotion).mockReturnValue(true);

    await render(<Skeleton circle height={48} />);

    expect(screen.getByRole("progressbar")).toBeTruthy();
    expect(withRepeat).not.toHaveBeenCalled();
  });

  it("is a low-opacity gray-500 shape with a token radius", async () => {
    const { rerender } = await render(<Skeleton />);
    expect(placeholderClasses()).toContain("bg-gray-500/15");
    expect(placeholderClasses()).toContain("rounded-sm");

    await rerender(<Skeleton radius="lg" />);
    expect(placeholderClasses()).toContain("rounded-lg");

    await rerender(<Skeleton circle height={48} />);
    expect(placeholderClasses()).toContain("rounded-pill");
  });
});
