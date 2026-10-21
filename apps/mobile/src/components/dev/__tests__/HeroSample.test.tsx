import { render, screen } from "@testing-library/react-native";

import { HeroSample } from "../HeroSample";

describe("HeroSample", () => {
  it("keeps the whole search prompt and the action visible: the prompt wraps, never truncates", async () => {
    await render(<HeroSample />);

    const prompt = screen.getByText("Describe the job");
    expect(prompt.props.numberOfLines).toBeUndefined();
    expect(prompt.props.allowFontScaling).not.toBe(false);
    expect(prompt.props.maxFontSizeMultiplier).toBeUndefined();
    expect(screen.getByText("Search")).toBeTruthy();
  });

  it("sets one headline word in green-500 on the navy sheet", async () => {
    await render(<HeroSample />);

    expect(screen.getByText("fixing").props.className).toContain("text-green-500");
    expect(screen.getByText(/What needs/).props.className).toContain("text-display");
  });
});
