import { fireEvent, render, screen } from "@testing-library/react-native";

import { ACCOUNT_GLYPHS } from "@/components/icons";

import { ListGroup, ListRow } from "../ListRow";

const HIDDEN = { includeHiddenElements: true };
const drawingsIn = (testID: string) =>
  screen.getByTestId(testID).queryAll((node) => node.type === "RNSVGSvgView", HIDDEN);

describe("ListRow", () => {
  it("a row that opens a screen is one button with its icon and a chevron", async () => {
    const onPress = jest.fn();
    await render(
      <ListRow label="Settings" glyph={ACCOUNT_GLYPHS.settings} onPress={onPress} testID="row" />,
    );

    await fireEvent.press(screen.getByRole("button", { name: "Settings" }));
    expect(onPress).toHaveBeenCalledTimes(1);
    // The tile's glyph and the chevron: two drawings, both hidden from screen readers.
    expect(drawingsIn("row")).toHaveLength(2);
  });

  it("an action row has no chevron; busy, it shows a spinner and ignores presses", async () => {
    const onPress = jest.fn();
    const row = (busy: boolean) => (
      <ListRow
        label="Log out"
        glyph={ACCOUNT_GLYPHS.logOut}
        chevron={false}
        busy={busy}
        onPress={onPress}
        testID="row"
      />
    );
    const view = await render(row(false));
    expect(drawingsIn("row")).toHaveLength(1);

    await view.rerender(row(true));
    await fireEvent.press(screen.getByRole("button", { name: "Log out" }));

    expect(onPress).not.toHaveBeenCalled();
    expect(screen.getByTestId("row-busy")).toBeOnTheScreen();
    expect(screen.getByRole("button").props.accessibilityState).toMatchObject({
      busy: true,
      disabled: true,
    });
  });

  it("a static row is text: the name and its value, no button", async () => {
    await render(<ListRow label="Email" value="maria@example.com" testID="row" />);

    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByTestId("row")).toHaveTextContent("Emailmaria@example.com");
  });

  it("a pressable row with a value reads both", async () => {
    await render(
      <ListRow label="Verify your phone" value="Not verified yet" onPress={jest.fn()} />,
    );

    expect(
      screen.getByRole("button", { name: "Verify your phone, Not verified yet" }),
    ).toBeOnTheScreen();
  });
});

describe("ListGroup", () => {
  it("puts a separator between rows, never before the first", async () => {
    await render(
      <ListGroup testID="group">
        <ListRow label="Settings" onPress={jest.fn()} />
        <ListRow label="Help" onPress={jest.fn()} />
        {null}
        <ListRow label="Legal" onPress={jest.fn()} />
      </ListGroup>,
    );

    expect(screen.getAllByTestId("group-separator")).toHaveLength(2);
    expect(screen.getAllByRole("button").map((row) => row.props.accessibilityLabel)).toEqual([
      "Settings",
      "Help",
      "Legal",
    ]);
  });
});
