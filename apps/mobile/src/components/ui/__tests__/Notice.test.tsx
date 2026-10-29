import { fireEvent, render, screen } from "@testing-library/react-native";

import { Button } from "../Button";
import { Notice } from "../Notice";

describe("Notice", () => {
  it("is an alert with its title in the tone's color and the body under it", async () => {
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
    expect(screen.getByText("We're not in this area yet").props.className).toContain("text-danger");
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
});
