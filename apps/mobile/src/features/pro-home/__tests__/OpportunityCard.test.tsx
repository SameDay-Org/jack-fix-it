import "@/i18n";

import { fireEvent, render, screen } from "@testing-library/react-native";

import { NOW, summary } from "../../opportunities/__tests__/helpers";
import { OpportunityCard } from "../OpportunityCard";

const onPress = jest.fn();

beforeEach(() => onPress.mockClear());

describe("OpportunityCard", () => {
  it("reads as one sentence: category, place, date, when it was sent, new", async () => {
    await render(<OpportunityCard opportunity={summary(1)} now={NOW} onPress={onPress} />);

    const card = screen.getByRole("button");
    expect(card.props.accessibilityLabel).toBe(
      "Painting, Fort Lauderdale 33301, Preferred Fri, Oct 30, Sent 2 h ago, New.",
    );
    // The lines inside say nothing on their own: the sentence is the whole card.
    expect(screen.queryByText("Painting")).toBeNull();
    expect(screen.getByText("Painting", { includeHiddenElements: true })).toBeTruthy();

    await fireEvent.press(card);
    expect(onPress).toHaveBeenCalledWith(summary(1));
  });

  it("an opened request with no category and no date reads shorter, as Other request", async () => {
    const opened = summary(2, {
      viewed: true,
      category: null,
      preferred_date: null,
      location: { zip_code: "33010", city: null },
      sent_at: "2026-10-28T13:59:30Z",
    });
    await render(<OpportunityCard opportunity={opened} now={NOW} onPress={onPress} />);

    expect(screen.getByRole("button").props.accessibilityLabel).toBe(
      "Other request, 33010, Sent just now.",
    );
    expect(screen.getByText("Other request", { includeHiddenElements: true })).toBeTruthy();
    expect(screen.queryByText("New", { includeHiddenElements: true })).toBeNull();
  });

  it("clamps the excerpt to two lines", async () => {
    await render(<OpportunityCard opportunity={summary(1)} now={NOW} onPress={onPress} />);

    const excerpt = screen.getByTestId(`opportunity-${summary(1).dispatch_id}-excerpt`, {
      includeHiddenElements: true,
    });
    expect(excerpt.props.numberOfLines).toBe(2);
    expect(excerpt.props.children).toBe(summary(1).description_excerpt);
  });
});
