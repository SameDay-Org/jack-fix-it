import { render, screen } from "@testing-library/react-native";

import { tokens, withOpacity } from "@/theme";

import { RECEIPT_SEEN, ReceiptTicks } from "../ReceiptTicks";

const HIDDEN = { includeHiddenElements: true };
const MUTED = withOpacity("white", 0.7);

/** WCAG 2.x relative luminance of a #RRGGBB color. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
// WCAG 1.4.11: a meaningful graphic needs 3:1 against what it sits on.
const AA_NON_TEXT = 3;

describe("ReceiptTicks", () => {
  it("draws seen in a light blue that reads on my navy bubble (at least 3:1)", () => {
    expect(contrast(RECEIPT_SEEN, tokens.colors["navy-900"])).toBeGreaterThanOrEqual(AA_NON_TEXT);
  });

  it.each([
    ["sent", 1, MUTED],
    ["delivered", 2, MUTED],
    ["seen", 2, RECEIPT_SEEN],
  ] as const)("draws %s as %i tick(s) in its color", async (state, ticks, color) => {
    await render(<ReceiptTicks state={state} testID="r" />);

    expect(screen.getAllByTestId("r-tick", HIDDEN)).toHaveLength(ticks);
    expect(screen.queryByTestId("r-clock", HIDDEN)).toBeNull();
    expect(screen.getByTestId("r", HIDDEN).props.stroke).toBe(color);
  });

  it("draws a muted clock while the message is on its way", async () => {
    await render(<ReceiptTicks state="sending" testID="r" />);

    expect(screen.getByTestId("r-clock", HIDDEN)).toBeTruthy();
    expect(screen.queryByTestId("r-tick", HIDDEN)).toBeNull();
    expect(screen.getByTestId("r", HIDDEN).props.stroke).toBe(MUTED);
  });

  it("is decorative: hidden from accessibility (the bubble says the state)", async () => {
    await render(<ReceiptTicks state="seen" testID="r" />);

    expect(screen.queryByTestId("r")).toBeNull();
    const svg = screen.getByTestId("r", HIDDEN);
    expect(svg.props.accessibilityElementsHidden).toBe(true);
    expect(svg.props.importantForAccessibility).toBe("no-hide-descendants");
  });
});
