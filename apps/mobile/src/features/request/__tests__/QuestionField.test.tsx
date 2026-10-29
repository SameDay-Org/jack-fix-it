import i18n from "@/i18n";

import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { useState } from "react";

import { QuestionField } from "../QuestionField";
import { questionError, type IntakeQuestion } from "../questions";
import type { IntakeAnswer } from "../requestDraft";
import { QUESTIONS } from "./helpers";

jest.mock("expo-glass-effect", () => ({
  GlassView: () => null,
  isLiquidGlassAvailable: () => false,
  isGlassEffectAPIAvailable: () => false,
}));

const answered = jest.fn<void, [IntakeAnswer | undefined]>();
// The stepper's buttons are touch only, hidden from accessibility: their queries opt in.
const HIDDEN = { includeHiddenElements: true };

/** The question with its answer held as the step holds it; `checked` shows its error. */
function Harness({
  question,
  checked = false,
  locale = "en",
}: {
  question: IntakeQuestion;
  checked?: boolean;
  locale?: string;
}) {
  const [answer, setAnswer] = useState<IntakeAnswer | undefined>(undefined);
  const error = checked ? (questionError(question, answer) ?? undefined) : undefined;
  return (
    <QuestionField
      question={question}
      answer={answer}
      error={error}
      locale={locale}
      onAnswer={(next) => {
        answered(next);
        setAnswer(next);
      }}
    />
  );
}

beforeEach(async () => {
  answered.mockClear();
  await act(() => i18n.changeLanguage("en"));
});

describe("QuestionField", () => {
  it("renders a small whole number as a stepper that stays inside its bounds", async () => {
    await render(<Harness question={QUESTIONS.rooms} checked />);

    expect(screen.getByText("Answer this to continue.")).toBeTruthy();
    expect(screen.getByRole("adjustable", { name: "How many rooms?" })).toBeTruthy();
    expect(screen.getByTestId("question-rooms-stepper-decrease", HIDDEN)).toBeDisabled();

    await fireEvent.press(screen.getByTestId("question-rooms-stepper-increase", HIDDEN));
    expect(answered).toHaveBeenLastCalledWith(1);
    expect(screen.queryByText("Answer this to continue.")).toBeNull();

    for (let press = 0; press < 8; press += 1) {
      await fireEvent.press(screen.getByTestId("question-rooms-stepper-increase", HIDDEN));
    }
    expect(screen.getByTestId("question-rooms-stepper-value")).toHaveTextContent("6");
    expect(screen.getByTestId("question-rooms-stepper-increase", HIDDEN)).toBeDisabled();
  });

  it("renders a wide whole number as a digits-only field and flags it out of bounds", async () => {
    await render(<Harness question={QUESTIONS.area} checked />);
    const field = screen.getByTestId("question-area-number");

    expect(screen.getByText("Square feet (optional)")).toBeTruthy();
    expect(field.props.maxLength).toBe(4);

    await fireEvent.changeText(field, "9a9");
    expect(answered).toHaveBeenLastCalledWith(99);
    expect(screen.getByText("Enter a number from 100 to 5000.")).toBeTruthy();

    await fireEvent.changeText(field, "");
    expect(answered).toHaveBeenLastCalledWith(undefined);
    expect(screen.queryByText("Enter a number from 100 to 5000.")).toBeNull();
  });

  it("renders a single choice as choice cards, one picked at a time, required", async () => {
    await render(<Harness question={QUESTIONS.surface} checked />);

    expect(screen.getByTestId("question-surface-error")).toHaveTextContent(
      "Answer this to continue.",
    );

    await fireEvent.press(screen.getByRole("radio", { name: "Walls" }));
    await fireEvent.press(screen.getByRole("radio", { name: "Ceiling" }));

    expect(answered).toHaveBeenLastCalledWith("ceiling");
    expect(screen.getByRole("radio", { name: "Ceiling" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Walls" })).not.toBeChecked();
    expect(screen.queryByTestId("question-surface-error")).toBeNull();
  });

  it("renders a multi choice as chips, up to its most, and clears when none is left", async () => {
    await render(<Harness question={QUESTIONS.extras} checked />);

    expect(screen.getByText("Pick up to 2.")).toBeTruthy();
    expect(screen.getByTestId("question-extras-error")).toHaveTextContent("Pick at least 1.");

    await fireEvent.press(screen.getByRole("checkbox", { name: "Trim" }));
    await fireEvent.press(screen.getByRole("checkbox", { name: "Doors" }));

    expect(answered).toHaveBeenLastCalledWith(["trim", "doors"]);
    expect(screen.getByRole("checkbox", { name: "Cabinets" })).toBeDisabled();

    await fireEvent.press(screen.getByRole("checkbox", { name: "Trim" }));
    await fireEvent.press(screen.getByRole("checkbox", { name: "Doors" }));

    expect(answered).toHaveBeenLastCalledWith(undefined);
    expect(screen.getByRole("checkbox", { name: "Cabinets" })).not.toBeDisabled();
  });

  it("renders a text as a multiline field with its limit; empty is no answer", async () => {
    await render(<Harness question={QUESTIONS.notes} />);
    const field = screen.getByTestId("question-notes");

    expect(screen.getByText("Colors you have in mind (optional)")).toBeTruthy();
    expect(field.props.multiline).toBe(true);
    expect(field.props.maxLength).toBe(200);

    await fireEvent.changeText(field, "Navy");
    expect(answered).toHaveBeenLastCalledWith("Navy");
    await fireEvent.changeText(field, "");
    expect(answered).toHaveBeenLastCalledWith(undefined);
  });

  it("renders a yes/no as a switch named by its label", async () => {
    await render(<Harness question={QUESTIONS.furnished} />);
    const toggle = screen.getByTestId("question-furnished-switch");

    expect(toggle.props.accessibilityLabel).toBe("Is the room furnished?");
    await fireEvent(toggle, "valueChange", true);
    expect(answered).toHaveBeenLastCalledWith(true);
  });

  it("shows the labels, options and errors in Spanish", async () => {
    await act(() => i18n.changeLanguage("es"));
    await render(<Harness question={QUESTIONS.surface} locale="es" checked />);

    expect(screen.getByText("¿Qué hay que pintar?")).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Paredes" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Techo" })).toBeTruthy();
    expect(screen.getByText("Responde esto para continuar.")).toBeTruthy();
  });
});
