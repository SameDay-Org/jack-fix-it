import { act, fireEvent, screen, within } from "@testing-library/react-native";

const HIDDEN = { includeHiddenElements: true };
const layout = (width: number, height: number) => ({
  nativeEvent: { layout: { x: 0, y: 0, width, height } },
});

/** Lays out the rotator's hidden measurement row, as the native side would. */
export async function measureRotatorWords(rotatorTestID = "launch-rotator") {
  const row = within(screen.getByTestId(`${rotatorTestID}-measure`, HIDDEN));
  await act(async () => {
    for (const node of row.getAllByText(/./, HIDDEN)) fireEvent(node, "layout", layout(40, 40));
  });
}

/**
 * Lays out the hero's measurement row and headline row, then its first fixed row, as the native
 * side would: the hero's first final frame.
 */
export async function layOutHero(headlineTestID = "launch-hero-headline") {
  const gauge = within(screen.getByTestId(`${headlineTestID}-gauge`, HIDDEN));
  await act(async () => {
    for (const node of gauge.getAllByText(/./, HIDDEN)) fireEvent(node, "layout", layout(40, 40));
    fireEvent(screen.getByTestId(headlineTestID, HIDDEN), "layout", layout(272, 120));
  });
  await act(async () => {
    fireEvent(screen.getByTestId(`${headlineTestID}-line-0`, HIDDEN), "layout", layout(272, 40));
  });
}
