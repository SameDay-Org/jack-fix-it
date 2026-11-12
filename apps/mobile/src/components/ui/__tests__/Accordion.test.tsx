import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { Text } from "react-native";
import Animated, { scrollTo, useReducedMotion, withTiming } from "react-native-reanimated";

import { tokens } from "@/theme";

import { AccordionRow, useAccordion } from "../Accordion";

jest.mock("react-native-reanimated", () => {
  const actual =
    jest.requireActual<typeof import("react-native-reanimated")>("react-native-reanimated");
  return {
    __esModule: true,
    ...actual,
    useReducedMotion: jest.fn(() => false),
    withTiming: jest.fn(actual.withTiming),
    scrollTo: jest.fn(),
  };
});

const HIDDEN = { includeHiddenElements: true };
const ROWS = ["first", "second", "third"] as const;

function List() {
  const accordion = useAccordion(ROWS);
  return (
    <Animated.ScrollView {...accordion.scroll} testID="scroll">
      {ROWS.map((id) => (
        <AccordionRow key={id} title={`Question ${id}`} testID={id} {...accordion.row(id)}>
          <Text>{`Answer ${id}`}</Text>
        </AccordionRow>
      ))}
    </Animated.ScrollView>
  );
}

const title = (id: string) => screen.getByRole("button", { name: `Question ${id}` });
const expanded = (id: string) => title(id).props.accessibilityState.expanded;

/** Lets Reanimated's mappers run: under Jest they start, and step, on animation frames. */
const frames = async (count = 4) => {
  for (let frame = 0; frame < count; frame += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
  }
};

/** Opens a row as the device would: the press, then the body's measured height. */
const openMeasured = async (id: string, height: number) => {
  await fireEvent.press(title(id));
  await fireEvent(screen.getByTestId(`${id}-body`), "layout", {
    nativeEvent: { layout: { x: 0, y: 0, width: 288, height } },
  });
  await frames();
};

const scrolledTo = async (y: number) => {
  await fireEvent.scroll(screen.getByTestId("scroll"), {
    nativeEvent: { contentOffset: { x: 0, y } },
  });
};

beforeEach(() => {
  jest.mocked(useReducedMotion).mockReturnValue(false);
  jest.mocked(withTiming).mockClear();
  jest.mocked(scrollTo).mockClear();
});

describe("AccordionRow", () => {
  it("shut, is a collapsed button with no body in the tree; a press asks to toggle", async () => {
    const onToggle = jest.fn();
    await render(
      <AccordionRow id="row" title="Question" open={false} onToggle={onToggle} testID="row">
        <Text>Answer</Text>
      </AccordionRow>,
    );

    expect(screen.getByRole("button", { name: "Question" }).props.accessibilityState).toEqual({
      expanded: false,
    });
    expect(screen.queryByText("Answer", HIDDEN)).toBeNull();

    await fireEvent.press(screen.getByRole("button", { name: "Question" }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("open, says it is expanded and shows its body, which takes its own height", async () => {
    await render(
      <AccordionRow id="row" title="Question" open onToggle={jest.fn()} testID="row">
        <Text>Answer</Text>
      </AccordionRow>,
    );

    expect(screen.getByRole("button").props.accessibilityState).toEqual({ expanded: true });
    expect(screen.getByText("Answer")).toBeOnTheScreen();
    // Out of the flow: the fold's height follows the body's measure, never the reverse.
    expect(screen.getByTestId("row-body")).toHaveStyle({ position: "absolute", top: 0 });
    expect(screen.getByTestId("row-fold")).toHaveStyle({ overflow: "hidden" });
  });

  it("the title is a 48 dp target at least, and its label wraps freely", async () => {
    await render(
      <AccordionRow id="row" title="Question" open={false} onToggle={jest.fn()} testID="row">
        <Text>Answer</Text>
      </AccordionRow>,
    );

    expect(screen.getByTestId("row-title").props.className).toContain("min-h-14");
    expect(screen.getByText("Question").props.numberOfLines).toBeUndefined();
  });
});

describe("useAccordion", () => {
  it("keeps one row open at a time; the one that shut leaves the tree after its fold", async () => {
    await render(<List />);

    await fireEvent.press(title("first"));
    expect(ROWS.map(expanded)).toEqual([true, false, false]);

    await fireEvent.press(title("third"));
    expect(ROWS.map(expanded)).toEqual([false, false, true]);
    expect(screen.getByText("Answer third")).toBeOnTheScreen();
    await waitFor(() => expect(screen.queryByText("Answer first", HIDDEN)).toBeNull());

    await fireEvent.press(title("third"));
    expect(ROWS.map(expanded)).toEqual([false, false, false]);
    await waitFor(() => expect(screen.queryByText("Answer third", HIDDEN)).toBeNull());
  });

  it("folds over the transition token, and in one frame under Reduce Motion", async () => {
    await render(<List />);

    await fireEvent.press(title("first"));
    expect(withTiming).toHaveBeenLastCalledWith(1, {
      duration: tokens.motion.transitionMs,
      easing: expect.any(Function),
    });

    jest.mocked(useReducedMotion).mockReturnValue(true);
    await fireEvent.press(title("first"));
    expect(withTiming).toHaveBeenLastCalledWith(0, { duration: 0 }, expect.any(Function));
    await waitFor(() => expect(screen.queryByText("Answer first", HIDDEN)).toBeNull());
  });

  it.each([
    [400, 100],
    // Near the top there is less to give back than the fold takes.
    [120, 0],
  ])(
    "a row folding above the opened one gives its height back to the scroll (%d to %d)",
    async (from, to) => {
      jest.mocked(useReducedMotion).mockReturnValue(true);
      await render(<List />);
      await openMeasured("first", 300);
      await scrolledTo(from);

      await fireEvent.press(title("third"));
      await frames();

      expect(scrollTo).toHaveBeenLastCalledWith(expect.anything(), 0, to, false);
    },
  );

  it("a row folding below the opened one, or shut on its own, leaves the scroll alone", async () => {
    jest.mocked(useReducedMotion).mockReturnValue(true);
    await render(<List />);
    await openMeasured("third", 300);
    await scrolledTo(400);

    await fireEvent.press(title("first"));
    await frames();
    await fireEvent.press(title("first"));
    await frames();

    expect(scrollTo).not.toHaveBeenCalled();
  });
});
