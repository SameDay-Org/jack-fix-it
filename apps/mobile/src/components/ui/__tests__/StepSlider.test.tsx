import { act, render, screen } from "@testing-library/react-native";
import { useState } from "react";
import { Text, TextInput } from "react-native";
import { useReducedMotion, withTiming } from "react-native-reanimated";

import { StepSlider } from "../StepSlider";

jest.mock("react-native-reanimated", () => {
  const actual =
    jest.requireActual<typeof import("react-native-reanimated")>("react-native-reanimated");
  return {
    __esModule: true,
    ...actual,
    useReducedMotion: jest.fn(() => false),
    withTiming: jest.fn(),
  };
});

type Step = "one" | "two";

/** A slider whose panes keep typed text in the parent, as the sign-up's forms do. */
function Harness({ onSettled }: { onSettled?: (step: Step) => void }) {
  const [step, setStep] = useState<Step>("one");
  const [direction, setDirection] = useState<1 | -1>(1);
  const [typed, setTyped] = useState("");
  return (
    <>
      <Text
        testID="go"
        onPress={() => {
          setDirection(step === "one" ? 1 : -1);
          setStep(step === "one" ? "two" : "one");
        }}
      >
        go
      </Text>
      <StepSlider
        stepKey={step}
        direction={direction}
        onSettled={onSettled}
        testID="slider"
        renderStep={(key) => (
          <>
            <Text accessibilityRole="header">{`pane ${key}`}</Text>
            {key === "one" ? (
              <TextInput accessibilityLabel="field" value={typed} onChangeText={setTyped} />
            ) : null}
          </>
        )}
      />
    </>
  );
}

// Every timing ends at once and reports it, so a transition settles inside the test.
const finishAtOnce = (to: number, _config?: object, done?: (finished?: boolean) => void) => {
  done?.(true);
  return to;
};

const go = async () => act(async () => screen.getByTestId("go").props.onPress());

beforeEach(() => {
  jest.mocked(useReducedMotion).mockReturnValue(false);
  jest.mocked(withTiming).mockReset().mockImplementation(finishAtOnce);
});

describe("StepSlider", () => {
  it("shows one pane, and swaps it for the next once the transition is done", async () => {
    const onSettled = jest.fn();
    await render(<Harness onSettled={onSettled} />);
    expect(screen.getByRole("header", { name: "pane one" })).toBeTruthy();
    expect(onSettled).not.toHaveBeenCalled(); // the first pane is simply there

    await go();

    expect(screen.getByRole("header", { name: "pane two" })).toBeTruthy();
    expect(screen.queryByRole("header", { name: "pane one" })).toBeNull();
    expect(screen.queryByTestId("slider-leaving", { includeHiddenElements: true })).toBeNull();
    expect(onSettled).toHaveBeenCalledWith("two");
  });

  it("slides: the new pane arrives from the side it is going to, the old one leaves the other way", async () => {
    await render(<Harness />);

    await go();

    const travels = jest
      .mocked(withTiming)
      .mock.calls.map(([to]) => to)
      .filter((to) => to !== 0 && to !== 1);
    expect(travels).toEqual([-320]); // the leaving pane, to the left; the new one ends at 0
  });

  it("keeps the leaving pane mounted, hidden from assistive technology, until it is gone", async () => {
    // The timings never finish here: the transition stays in the middle.
    jest.mocked(withTiming).mockImplementation((to: number) => to);
    await render(<Harness />);
    await act(async () => screen.getByLabelText("field").props.onChangeText("kept"));

    await go();

    const leaving = screen.getByTestId("slider-leaving", { includeHiddenElements: true });
    expect(leaving.props.importantForAccessibility).toBe("no-hide-descendants");
    expect(leaving.props.pointerEvents).toBe("none");
    expect(screen.getByLabelText("field", { includeHiddenElements: true }).props.value).toBe(
      "kept",
    );
    expect(screen.queryByLabelText("field")).toBeNull(); // not reachable while it leaves
  });

  it("crossfades in place under Reduce Motion", async () => {
    jest.mocked(useReducedMotion).mockReturnValue(true);
    const onSettled = jest.fn();
    await render(<Harness onSettled={onSettled} />);

    await go();

    const targets = jest.mocked(withTiming).mock.calls.map(([to]) => to);
    expect(targets.sort()).toEqual([0, 1]); // one pane fades out, the other in: no travel
    expect(onSettled).toHaveBeenCalledWith("two");
  });
});
