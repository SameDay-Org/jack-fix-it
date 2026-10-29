import { fireEvent, render, screen } from "@testing-library/react-native";
import { useIsFocused } from "expo-router";
import { AccessibilityInfo } from "react-native";

import { Button } from "../Button";
import { Notice } from "../Notice";

// Outside a navigator expo-router's hook throws, as it does here by default; a test that puts the
// notice on a screen returns that screen's focus instead.
jest.mock("expo-router", () => ({
  useIsFocused: jest.fn(() => {
    throw new Error("Couldn't find a focus context.");
  }),
}));

let announce: jest.SpyInstance;

beforeEach(() => {
  announce = jest
    .spyOn(AccessibilityInfo, "announceForAccessibilityWithOptions")
    .mockImplementation();
});

afterEach(() => announce.mockRestore());

describe("Notice", () => {
  it("is an alert in the tone's tint, navy title and the body under it", async () => {
    await render(
      <Notice
        tone="danger"
        title="We're not in this area yet"
        body="Try another address."
        testID="notice"
      />,
    );

    const notice = screen.getByTestId("notice");
    expect(notice.props.accessibilityRole).toBe("alert");
    expect(notice.props.className).toContain("bg-danger/10");
    expect(notice.props.className).toContain("rounded-lg");
    expect(screen.getByText("We're not in this area yet").props.className).toContain(
      "text-navy-900",
    );
    expect(screen.getByText("Try another address.")).toBeTruthy();
  });

  it("info: a navy tint, the title alone, and the action that resolves it", async () => {
    const retry = jest.fn();
    await render(
      <Notice tone="info" title="We couldn't load your saved addresses." testID="notice">
        <Button label="Try again" onPress={retry} />
      </Notice>,
    );

    expect(screen.getByTestId("notice").props.className).toContain("bg-navy-900/5");
    expect(screen.getAllByText(/./)).toHaveLength(2); // the title and the button's label
    await fireEvent.press(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("announces its text when it appears and when it changes, not on a same-text render", async () => {
    const notice = (body: string) => (
      <Notice tone="danger" title="We're not in this area yet" body={body} />
    );
    const { rerender } = await render(notice("Try another address."));

    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenLastCalledWith("We're not in this area yet. Try another address.", {
      queue: true,
    });

    await rerender(notice("Try another address."));
    expect(announce).toHaveBeenCalledTimes(1);

    await rerender(notice("Pick a saved address instead."));
    expect(announce).toHaveBeenCalledTimes(2);
    expect(announce).toHaveBeenLastCalledWith(
      "We're not in this area yet. Pick a saved address instead.",
      { queue: true },
    );
  });

  it("a title that ends a sentence is not given a second period", async () => {
    await render(<Notice tone="info" title="We couldn't load them." body="Try again." />);

    expect(announce).toHaveBeenCalledWith("We couldn't load them. Try again.", { queue: true });
  });

  it("waits until its screen is in front: a notice under another screen speaks on its return", async () => {
    // A screen kept mounted under another one, as a stack keeps the steps behind Review.
    let focused = false;
    jest.mocked(useIsFocused).mockImplementation(() => focused);
    const notice = (title: string) => <Notice tone="danger" title={title} />;
    const { rerender } = await render(notice("We're not in this area yet"));
    const show = async (next: boolean, title = "We're not in this area yet") => {
      focused = next;
      await rerender(notice(title)); // a focus change re-renders the screen
    };
    expect(announce).not.toHaveBeenCalled();

    await show(true);
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenLastCalledWith("We're not in this area yet", { queue: true });

    await show(false); // away and back with the same text: said once only
    await show(true);
    expect(announce).toHaveBeenCalledTimes(1);

    await show(false, "Something went wrong"); // changed while away: said on return
    expect(announce).toHaveBeenCalledTimes(1);
    await show(true, "Something went wrong");
    expect(announce).toHaveBeenCalledTimes(2);
  });
});
