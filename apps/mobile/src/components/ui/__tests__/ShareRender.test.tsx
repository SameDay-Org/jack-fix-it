import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { createRef } from "react";
import { PixelRatio, Text } from "react-native";

import { ShareRender } from "../ShareRender";
import type { ShareHandle } from "../shareCapture";

// Root manual mock (apps/mobile/__mocks__): ViewShot is a plain host view, `capture` on its ref.
jest.mock("react-native-view-shot");

const HIDDEN = { includeHiddenElements: true } as const;
const BASE_WIDTH = 360;
const CONTENT_HEIGHT = 600;

async function renderShare() {
  const ref = createRef<ShareHandle>();
  await render(
    <ShareRender ref={ref} baseWidth={BASE_WIDTH} dirName="share-test" prefix="test" testID="share">
      <Text>Receipt JF-000124</Text>
    </ShareRender>,
  );
  const content = screen.getByTestId("share-content", HIDDEN);
  await act(async () =>
    fireEvent(content, "layout", {
      nativeEvent: { layout: { x: 0, y: 0, width: BASE_WIDTH, height: CONTENT_HEIGHT } },
    }),
  );
  return { ref, content: screen.getByTestId("share-content", HIDDEN) };
}

afterEach(() => jest.restoreAllMocks());

describe("ShareRender", () => {
  it("lays the content out at the design width and draws it 3x on a 1x screen", async () => {
    jest.spyOn(PixelRatio, "get").mockReturnValue(1);
    const { content } = await renderShare();

    // Laid out like on a phone (placed absolutely: the capture's height, 0 before the first
    // layout, must not squeeze it), then scaled up from its top left corner...
    expect(content).toHaveStyle({
      position: "absolute",
      width: BASE_WIDTH,
      transformOrigin: "top left",
      transform: [{ scale: 3 }],
    });
    // ...into a capture three times as wide and as tall: the PNG is 1080 px wide, text included.
    expect(content.parent).toHaveStyle({ width: BASE_WIDTH * 3, height: CONTENT_HEIGHT * 3 });
    expect(screen.getByTestId("share", HIDDEN)).toHaveStyle({ width: BASE_WIDTH * 3 });
  });

  it("draws at its own size where the screen is already 3x or more", async () => {
    jest.spyOn(PixelRatio, "get").mockReturnValue(3.5);
    const { content } = await renderShare();

    expect(content).toHaveStyle({ width: BASE_WIDTH, transform: [{ scale: 1 }] });
    expect(content.parent).toHaveStyle({ width: BASE_WIDTH, height: CONTENT_HEIGHT });
  });

  it("is off screen and hidden from assistive technology", async () => {
    jest.spyOn(PixelRatio, "get").mockReturnValue(1);
    await renderShare();

    expect(screen.queryByText("Receipt JF-000124")).toBeNull();
    expect(screen.getByTestId("share", HIDDEN)).toHaveStyle({ position: "absolute" });
    expect(screen.getByTestId("share", HIDDEN).props.importantForAccessibility).toBe(
      "no-hide-descendants",
    );
  });
});
