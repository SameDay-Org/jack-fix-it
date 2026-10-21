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
});
