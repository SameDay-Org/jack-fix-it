import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { NavigationContext } from "expo-router/react-navigation";
import type { ComponentProps } from "react";
import { AccessibilityInfo } from "react-native";

import { Button } from "../Button";
import { Notice } from "../Notice";

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
    const listeners = new Set<() => void>();
    let focused = false;
    const navigation = {
      isFocused: () => focused,
      addListener: (_event: "focus" | "blur", listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    } as unknown as NonNullable<ComponentProps<typeof NavigationContext.Provider>["value"]>;
    const setFocused = (next: boolean) =>
      act(() => {
        focused = next;
        listeners.forEach((listener) => listener());
      });
    const notice = (title: string) => (
      <NavigationContext.Provider value={navigation}>
        <Notice tone="danger" title={title} />
      </NavigationContext.Provider>
    );

    const { rerender } = await render(notice("We're not in this area yet"));
    expect(announce).not.toHaveBeenCalled();

    await setFocused(true);
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenLastCalledWith("We're not in this area yet", { queue: true });

    await setFocused(false); // away and back with the same text: said once only
    await setFocused(true);
    expect(announce).toHaveBeenCalledTimes(1);

    await setFocused(false);
    await rerender(notice("Something went wrong")); // changed while away: said on return
    expect(announce).toHaveBeenCalledTimes(1);
    await setFocused(true);
    expect(announce).toHaveBeenCalledTimes(2);
  });
});
