import { render, screen } from "@testing-library/react-native";

import { StatusBadge, type StatusTone } from "../StatusBadge";

const TONES: StatusTone[] = ["neutral", "info", "success", "warning", "danger", "brand"];

describe("StatusBadge", () => {
  it.each(TONES)("renders the given label for tone %s", async (tone) => {
    await render(<StatusBadge label="Scheduled" tone={tone} />);

    const text = screen.getByText("Scheduled");
    expect(text.props.accessibilityRole).toBe("text");
  });
});
