import { render, screen } from "@testing-library/react-native";

import { StatusBadge, type StatusTone } from "../StatusBadge";

const TONES: StatusTone[] = ["neutral", "info", "success", "warning", "danger", "brand"];

const badge = () => screen.getByTestId("badge");

describe("StatusBadge", () => {
  it.each(TONES)("renders the given label as a caption pill for tone %s", async (tone) => {
    await render(<StatusBadge label="Scheduled" tone={tone} testID="badge" />);

    const text = screen.getByText("Scheduled");
    expect(text.props.accessibilityRole).toBe("text");
    expect(text.props.className).toContain("text-caption");
    expect(badge().props.className).toContain("rounded-pill");
  });

  it("success badge uses green-700, never success", async () => {
    await render(<StatusBadge label="Done" tone="success" testID="badge" />);

    expect(badge().props.className).toContain("bg-green-700");
    expect(badge().props.className).not.toMatch(/success/);
    expect(screen.getByText("Done").props.className).toContain("text-white");
    expect(screen.getByText("Done").props.className).not.toMatch(/success/);
  });

  it("warning badge is navy text on warning fill", async () => {
    await render(<StatusBadge label="Pending" tone="warning" testID="badge" />);

    expect(badge().props.className).toMatch(/\bbg-warning\b(?!\/)/);
    expect(screen.getByText("Pending").props.className).toContain("text-navy-900");
    expect(screen.getByText("Pending").props.className).not.toMatch(/warning/);
  });
});
