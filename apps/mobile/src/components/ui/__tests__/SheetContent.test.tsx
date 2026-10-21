import { render, screen } from "@testing-library/react-native";
import type { ReactElement } from "react";
import { Text } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { SheetContent } from "../SheetContent";

jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);
jest.mock("expo-glass-effect", () => ({
  GlassView: () => null,
  isLiquidGlassAvailable: jest.fn(() => false),
  isGlassEffectAPIAvailable: jest.fn(() => false),
}));

const METRICS = {
  frame: { x: 0, y: 0, width: 320, height: 640 },
  insets: { top: 24, right: 0, bottom: 34, left: 0 },
};

const renderInSafeArea = (ui: ReactElement) =>
  render(<SafeAreaProvider initialMetrics={METRICS}>{ui}</SafeAreaProvider>);

describe("SheetContent", () => {
  it("renders title, body and actions", async () => {
    await renderInSafeArea(
      <SheetContent title="Confirm the visit" actions={<Text>Confirm</Text>} testID="sheet">
        <Text>Body</Text>
      </SheetContent>,
    );

    expect(screen.getByText("Confirm the visit").props.className).toContain("text-title-2");
    expect(screen.getByText("Body")).toBeTruthy();
    expect(screen.getByText("Confirm")).toBeTruthy();
  });

  it("applies bottom safe area padding and the white surface without glass", async () => {
    await renderInSafeArea(
      <SheetContent testID="sheet">
        <Text>Body</Text>
      </SheetContent>,
    );

    expect(screen.getByTestId("sheet-inset").props.style).toMatchObject({ paddingBottom: 34 });
    expect(screen.getByTestId("sheet").props.className).toContain("bg-white");
    expect(screen.queryByText("Confirm the visit")).toBeNull();
  });

  it("fills the sheet with fraction detents and sizes from the content with fitToContents", async () => {
    // Android shows only the dimmed backdrop when a fit-to-contents sheet gets a flex: 1 root.
    const withDetents = await renderInSafeArea(
      <SheetContent testID="sheet">
        <Text>Body</Text>
      </SheetContent>,
    );
    const detents = withDetents.getByTestId("sheet").props.className.split(" ");
    withDetents.unmount();
    const fitted = await renderInSafeArea(
      <SheetContent testID="sheet" fitToContents>
        <Text>Body</Text>
      </SheetContent>,
    );
    const fit = fitted.getByTestId("sheet").props.className.split(" ");

    expect(detents).toContain("flex-1");
    expect(fit).not.toContain("flex-1");
    expect(fit).toContain("shrink");
    expect(fit).toContain("bg-white");
  });
});
