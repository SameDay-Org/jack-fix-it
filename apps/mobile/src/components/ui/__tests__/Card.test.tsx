import { fireEvent, render, screen } from "@testing-library/react-native";
import { Text } from "react-native";

import { Card } from "../Card";

describe("Card", () => {
  it("renders as a pressable button with label when onPress is set", async () => {
    const onPress = jest.fn();
    await render(
      <Card onPress={onPress} accessibilityLabel="Open job">
        <Text>Job</Text>
      </Card>,
    );

    await fireEvent.press(screen.getByRole("button", { name: "Open job" }));

    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("renders as a plain view without onPress", async () => {
    await render(
      <Card>
        <Text>Job</Text>
      </Card>,
    );

    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Job")).toBeTruthy();
  });
});
