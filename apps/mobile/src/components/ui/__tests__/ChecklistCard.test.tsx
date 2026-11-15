import { fireEvent, render, screen } from "@testing-library/react-native";

import { ChecklistCard, ChecklistCardSkeleton } from "../ChecklistCard";

const STEPS = [
  { id: "photo", label: "Profile photo", done: true, accessibilityLabel: "Profile photo: done" },
  { id: "about", label: "About you", done: false, accessibilityLabel: "About you: to do" },
];

describe("ChecklistCard", () => {
  it("shows the title, the progress and every step with its spoken state", async () => {
    await render(
      <ChecklistCard
        title="Finish your profile"
        progress="1 of 2 done"
        steps={STEPS}
        actionLabel="Complete profile"
        onAction={() => undefined}
        testID="list"
      />,
    );

    expect(screen.getByRole("header", { name: "Finish your profile" })).toBeTruthy();
    expect(screen.getByTestId("list-progress")).toHaveTextContent("1 of 2 done");
    expect(screen.getByTestId("list-photo").props.accessibilityLabel).toBe("Profile photo: done");
    expect(screen.getByTestId("list-about").props.accessibilityLabel).toBe("About you: to do");
  });

  it("runs its one action", async () => {
    const onAction = jest.fn();
    await render(
      <ChecklistCard
        title="Finish your profile"
        progress="1 of 2 done"
        steps={STEPS}
        actionLabel="Complete profile"
        onAction={onAction}
        testID="list"
      />,
    );

    await fireEvent.press(screen.getByRole("button", { name: "Complete profile" }));

    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it("has a placeholder with no control in it", async () => {
    await render(<ChecklistCardSkeleton steps={3} testID="list-loading" />);

    expect(screen.getByTestId("list-loading")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
