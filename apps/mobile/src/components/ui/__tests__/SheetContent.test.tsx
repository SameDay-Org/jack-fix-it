import { render, screen, type RenderResult } from "@testing-library/react-native";
import type { ReactElement } from "react";
import { Dimensions, Text } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { tokens } from "@/theme";

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

type HostNode = ReturnType<RenderResult["getByTestId"]>;

/** The body scroll view's flattened style under a rendered sheet root (`{}` when it has none). */
function bodyStyle(root: HostNode): Record<string, unknown> | undefined {
  const queue: (HostNode | string)[] = [root];
  for (let node = queue.shift(); node !== undefined; node = queue.shift()) {
    if (typeof node === "string") continue;
    if (/ScrollView/.test(node.type)) {
      const style: unknown = node.props.style;
      const layers = Array.isArray(style) ? style : [style ?? {}];
      return Object.assign({}, ...layers) as Record<string, unknown>;
    }
    queue.push(...node.children);
  }
  return undefined;
}

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

  it("caps a fit-to-contents body at the token fraction of the window so the actions stay in view", async () => {
    const { height } = Dimensions.get("window");
    const withDetents = await renderInSafeArea(
      <SheetContent testID="sheet">
        <Text>Body</Text>
      </SheetContent>,
    );
    const detentsRoot = withDetents.getByTestId("sheet");
    expect(bodyStyle(detentsRoot)).toBeDefined();
    expect(bodyStyle(detentsRoot)?.maxHeight).toBeUndefined();

    const fitted = await renderInSafeArea(
      <SheetContent testID="sheet" fitToContents>
        <Text>Body</Text>
      </SheetContent>,
    );
    expect(bodyStyle(fitted.getByTestId("sheet"))?.maxHeight).toBe(
      height * tokens.sheet.fitBodyMaxFraction,
    );
  });
});
