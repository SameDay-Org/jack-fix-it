import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { Text } from "react-native";
import Animated, { measure, scrollTo, useReducedMotion, withTiming } from "react-native-reanimated";

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
    measure: jest.fn(() => null),
  };
});

const HIDDEN = { includeHiddenElements: true };
const ROWS = ["first", "second", "third", "fourth"] as const;

/** `open` forces which rows are open: the state of rows tapped faster than they fold. */
function List({ open }: { open?: readonly string[] }) {
  const accordion = useAccordion(ROWS);
  return (
    <Animated.ScrollView {...accordion.scroll} testID="scroll">
      {ROWS.map((id) => {
        const row = accordion.row(id);
        return (
          <AccordionRow
            key={id}
            title={`Question ${id}`}
            testID={id}
            {...row}
            open={open ? open.includes(id) : row.open}
          >
            <Text>{`Answer ${id}`}</Text>
          </AccordionRow>
        );
      })}
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

/** The body's layout event: Jest has no layout engine, the device sends this on mount. */
const measured = (id: string, height: number) =>
  fireEvent(screen.getByTestId(`${id}-body`), "layout", {
    nativeEvent: { layout: { x: 0, y: 0, width: 288, height } },
  });

/** A finger on a row's title: `top` is where the title's top edge is on screen. */
const TITLE = 56;
const pressAt = (id: string, top: number) =>
  fireEvent.press(title(id), { nativeEvent: { pageY: top + 20, locationY: 20 } });

/** Opens a row as the device would: the press, then the body's measured height, then the fold. */
const openMeasured = async (id: string, height: number, top = 0) => {
  await pressAt(id, top);
  await fireEvent(title(id), "layout", { nativeEvent: { layout: { height: TITLE } } });
  await measured(id, height);
  await waitFor(() => expect(lastTiming()).toEqual([1, true]));
  await frames();
};

const scrolledTo = (y: number) =>
  fireEvent.scroll(screen.getByTestId("scroll"), { nativeEvent: { contentOffset: { x: 0, y } } });

/** The scroll positions the list asked for, in order. */
const scrolls = () => jest.mocked(scrollTo).mock.calls.map(([, , y]) => y);

const lastScroll = () => scrolls()[scrolls().length - 1];

/** The last fold started and whether it has finished: `[target, done]`. */
const timings: [number, boolean][] = [];
const lastTiming = () => timings[timings.length - 1];

beforeEach(() => {
  timings.length = 0;
  jest.mocked(useReducedMotion).mockReturnValue(false);
  jest.mocked(scrollTo).mockClear();
  jest.mocked(measure).mockReset().mockReturnValue(null);
  const actual =
    jest.requireActual<typeof import("react-native-reanimated")>("react-native-reanimated");
  jest
    .mocked(withTiming)
    .mockReset()
    .mockImplementation((to, config, done) => {
      const entry: [number, boolean] = [to as number, false];
      timings.push(entry);
      return actual.withTiming(to, config, (finished, current) => {
        entry[1] = finished === true;
        done?.(finished, current);
      });
    });
});

describe("AccordionRow", () => {
  it("shut, is a collapsed button with no body in the tree; a press asks to toggle", async () => {
    const onToggle = jest.fn();
    await render(
      <AccordionRow title="Question" open={false} onToggle={onToggle} testID="row">
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
      <AccordionRow title="Question" open onToggle={jest.fn()} testID="row">
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
      <AccordionRow title="Question" open={false} onToggle={jest.fn()} testID="row">
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
    expect(ROWS.map(expanded)).toEqual([true, false, false, false]);

    await fireEvent.press(title("third"));
    expect(ROWS.map(expanded)).toEqual([false, false, true, false]);
    expect(screen.getByText("Answer third")).toBeOnTheScreen();
    await waitFor(() => expect(screen.queryByText("Answer first", HIDDEN)).toBeNull());

    await fireEvent.press(title("third"));
    expect(ROWS.map(expanded)).toEqual([false, false, false, false]);
    await waitFor(() => expect(screen.queryByText("Answer third", HIDDEN)).toBeNull());
  });

  it("a first unfold waits for the body's height, then runs over the transition token", async () => {
    await render(<List />);

    await fireEvent.press(title("first"));
    // Started blind, the fold would jump to wherever the curve is when the height lands.
    expect(withTiming).not.toHaveBeenCalled();

    await measured("first", 300);
    expect(withTiming).toHaveBeenLastCalledWith(
      1,
      { duration: tokens.motion.transitionMs, easing: expect.any(Function) },
      expect.any(Function),
    );
  });

  it("an unfold of a row measured before starts at once", async () => {
    await render(<List />);
    await openMeasured("first", 300);
    await fireEvent.press(title("first"));
    await waitFor(() => expect(screen.queryByText("Answer first", HIDDEN)).toBeNull());

    await fireEvent.press(title("first"));

    expect(lastTiming()[0]).toBe(1);
  });

  it("folds in one frame under Reduce Motion", async () => {
    jest.mocked(useReducedMotion).mockReturnValue(true);
    await render(<List />);

    await fireEvent.press(title("first"));
    await measured("first", 300);
    expect(withTiming).toHaveBeenLastCalledWith(1, { duration: 0 }, expect.any(Function));

    await fireEvent.press(title("first"));
    expect(withTiming).toHaveBeenLastCalledWith(0, { duration: 0 }, expect.any(Function));
    await waitFor(() => expect(screen.queryByText("Answer first", HIDDEN)).toBeNull());
  });

  it("a row opened again while it folds keeps its body", async () => {
    await render(<List />);
    await openMeasured("first", 300);

    await fireEvent.press(title("first"));
    await fireEvent.press(title("first"));
    await waitFor(() => expect(lastTiming()).toEqual([1, true]));
    await frames();

    expect(expanded("first")).toBe(true);
    expect(screen.getByText("Answer first")).toBeOnTheScreen();
  });

  it("a row folding above the opened one gives its height back, frame by frame", async () => {
    await render(<List />);
    await openMeasured("first", 300);
    await scrolledTo(400);

    await fireEvent.press(title("third"));
    await waitFor(() => expect(lastScroll()).toBeCloseTo(100, 3));

    // Several frames, each a little further, none past the row's whole height: the scroll view
    // never reported an offset in between, so the list kept count itself.
    expect(scrolls().length).toBeGreaterThan(2);
    expect(scrolls()).toEqual([...scrolls()].sort((a, b) => b - a));
    expect(
      jest.mocked(scrollTo).mock.calls.every(([, x, , animated]) => x === 0 && !animated),
    ).toBe(true);
  });

  it("gives back no more than the scroll has: near the top it stops at zero", async () => {
    jest.mocked(useReducedMotion).mockReturnValue(true);
    await render(<List />);
    await openMeasured("first", 300);
    await scrolledTo(120);

    await fireEvent.press(title("third"));
    await frames();

    expect(scrolls()).toEqual([0]);
  });

  it("starts each switch from where the scroll is then", async () => {
    jest.mocked(useReducedMotion).mockReturnValue(true);
    await render(<List />);
    await openMeasured("first", 300);
    await scrolledTo(400);
    await openMeasured("third", 200);
    expect(scrolls()).toEqual([100]);

    await scrolledTo(700);
    await fireEvent.press(title("fourth"));
    await frames();

    expect(scrolls()).toEqual([100, 500]);
  });

  it("gives back the height of every row folding above the tapped one", async () => {
    // Rows tapped faster than they fold: two are still folding when a third, below, is tapped.
    jest.mocked(useReducedMotion).mockReturnValue(true);
    const view = await render(<List open={["first", "second"]} />);
    await measured("first", 300);
    await measured("second", 200);
    await frames();
    await scrolledTo(700);

    await fireEvent.press(title("fourth"));
    await view.rerender(<List open={[]} />);
    await frames();

    expect(scrolls()).toEqual([400, 200]);
  });

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

  /** The scroll view's own frame, the one thing measured: under a 24 dp bar, 592 dp tall. */
  const viewport = () =>
    jest
      .mocked(measure)
      .mockReturnValue({ x: 0, y: 24, width: 320, height: 592, pageX: 0, pageY: 24 });

  it.each([
    // The answer ends 184 dp below the scroll view: it comes up by that much.
    [500, 244, 584],
    // Taller than the screen: only until the title reaches the top.
    [100, 844, 476],
  ])("brings an unfolded answer that ends off screen into view (%d, %d)", async (top, body, to) => {
    viewport();
    await render(<List />);
    await scrolledTo(400);

    await openMeasured("second", body, top);

    expect(jest.mocked(scrollTo).mock.calls).toEqual([[expect.anything(), 0, to, true]]);
  });

  it("brings it up from where the hold left the scroll, at once under Reduce Motion", async () => {
    jest.mocked(useReducedMotion).mockReturnValue(true);
    viewport();
    await render(<List />);
    await openMeasured("first", 300);
    await scrolledTo(400);

    await openMeasured("second", 244, 500);

    // The fold of the first row gave 300 back; the reveal starts from there, not from 400.
    expect(scrolls()).toEqual([100, 284]);
    expect(jest.mocked(scrollTo).mock.calls[1][3]).toBe(false);
  });

  it("counts how far the row rose when the scroll ran out above it", async () => {
    jest.mocked(useReducedMotion).mockReturnValue(true);
    viewport();
    await render(<List />);
    await openMeasured("first", 300);
    await scrolledTo(120);

    await openMeasured("second", 244, 500);

    // Only 120 of the 300 could be given back: the row rose 180, to 320, and its answer now ends
    // 4 dp below the scroll view.
    expect(scrolls()).toEqual([0, 4]);
  });

  it("leaves an answer that fits where it is", async () => {
    viewport();
    await render(<List />);

    await openMeasured("second", 244, 200);

    expect(measure).toHaveBeenCalledTimes(1);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("does not guess where the row is when the press says nothing (a screen reader)", async () => {
    viewport();
    await render(<List />);

    await fireEvent.press(title("second"), { nativeEvent: {} });
    await measured("second", 844);
    await waitFor(() => expect(lastTiming()).toEqual([1, true]));
    await frames();

    expect(expanded("second")).toBe(true);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("stops moving the page once the reader drags it", async () => {
    viewport();
    await render(<List />);
    await openMeasured("first", 300);
    await scrolledTo(400);

    await pressAt("third", 500);
    await measured("third", 244);
    await fireEvent(screen.getByTestId("scroll"), "scrollBeginDrag", {
      nativeEvent: { contentOffset: { x: 0, y: 400 } },
    });
    const moves = scrolls().length;
    await waitFor(() => expect(screen.queryByText("Answer first", HIDDEN)).toBeNull());
    await waitFor(() => expect(lastTiming()).toEqual([1, true]));
    await frames();

    // Neither the rest of the fold above nor the reveal of the opened answer.
    expect(scrolls()).toHaveLength(moves);
  });
});
