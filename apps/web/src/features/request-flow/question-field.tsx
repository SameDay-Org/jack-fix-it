"use client";

import type { Locale } from "@/i18n/config";

import { CHOICE, CHOICE_INPUT, describedBy, ERROR, fill, HINT, INPUT, LABEL } from "./fields";
import {
  type IntakeAnswer,
  type IntakeQuestion,
  localized,
  offeredPicks,
  type QuestionError,
} from "./questions";
import type { RequestFlowText } from "./types";

/** The id of a question's field, or of its first option: where the error box links to. */
export function questionFieldId(key: string, type: IntakeQuestion["type"]): string {
  return type === "single_choice" || type === "multi_choice" ? `q-${key}-0` : `q-${key}`;
}

export function questionErrorText(
  text: RequestFlowText["questions"],
  error: QuestionError,
): string {
  switch (error.kind) {
    case "required":
      return text.required;
    case "range":
      return fill(text.range, { min: error.min, max: error.max });
    case "tooFew":
      return fill(text.tooFew, { count: error.count });
    case "tooMany":
      return fill(text.tooMany, { count: error.count });
  }
}

type QuestionFieldProps = {
  question: IntakeQuestion;
  answer: IntakeAnswer | undefined;
  error: QuestionError | undefined;
  locale: Locale;
  text: RequestFlowText;
  onAnswer: (answer: IntakeAnswer | undefined) => void;
};

/**
 * One intake question by its type, with its label, its help and its error: a number field, radio
 * buttons, checkboxes, one checkbox for a yes/no, or a text box. Labels come from the category's
 * data and are shown as plain text.
 */
export function QuestionField({
  question,
  answer,
  error,
  locale,
  text,
  onAnswer,
}: QuestionFieldProps) {
  const id = `q-${question.key}`;
  const label = localized(question.labels, locale);
  const shown =
    question.required || question.type === "boolean" ? label : fill(text.optional, { label });
  const help = question.help ? localized(question.help, locale) : null;
  const message = error ? questionErrorText(text.questions, error) : null;
  const errorLine = message ? (
    <p id={`${id}-error`} className={ERROR}>
      {message}
    </p>
  ) : null;

  if (question.type === "single_choice" || question.type === "multi_choice") {
    const multiple = question.type === "multi_choice";
    const picks = multiple ? offeredPicks(question, answer) : [];
    const most = multiple ? question.max_selected : null;
    const hint = [help, most ? fill(text.questions.pickUpTo, { count: most }) : null]
      .filter(Boolean)
      .join(" ");
    return (
      <fieldset aria-describedby={describedBy(id, hint !== "", message !== null)}>
        <legend className={LABEL}>{shown}</legend>
        {hint ? (
          <p id={`${id}-hint`} className={HINT}>
            {hint}
          </p>
        ) : null}
        {errorLine}
        <div className="mt-3 flex flex-col gap-2">
          {question.options.map((option, index) => {
            const description = option.description ? localized(option.description, locale) : null;
            const checked = multiple ? picks.includes(option.value) : answer === option.value;
            return (
              <label key={option.value} className={CHOICE}>
                <input
                  id={`${id}-${index}`}
                  type={multiple ? "checkbox" : "radio"}
                  name={id}
                  value={option.value}
                  checked={checked}
                  aria-invalid={message ? true : undefined}
                  className={CHOICE_INPUT}
                  onChange={(event) => {
                    if (!multiple) return onAnswer(option.value);
                    const next = event.target.checked
                      ? [...picks, option.value]
                      : picks.filter((value) => value !== option.value);
                    onAnswer(next.length > 0 ? next : undefined);
                  }}
                />
                <span className="flex flex-col">
                  <span className="font-semibold text-navy-900">
                    {localized(option.labels, locale)}
                  </span>
                  {description ? (
                    <span className="text-sm text-gray-500">{description}</span>
                  ) : null}
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>
    );
  }

  if (question.type === "boolean") {
    return (
      <div>
        <label className={CHOICE}>
          <input
            id={id}
            type="checkbox"
            checked={answer === true}
            aria-describedby={describedBy(id, help !== null, false)}
            className={CHOICE_INPUT}
            onChange={(event) => onAnswer(event.target.checked)}
          />
          <span className="font-semibold text-navy-900">{shown}</span>
        </label>
        {help ? (
          <p id={`${id}-hint`} className={HINT}>
            {help}
          </p>
        ) : null}
      </div>
    );
  }

  const field =
    question.type === "integer" ? (
      <input
        id={id}
        type="number"
        inputMode="numeric"
        min={question.min}
        max={question.max}
        step={1}
        value={answer === undefined ? "" : String(answer)}
        aria-invalid={message ? true : undefined}
        aria-describedby={describedBy(id, help !== null, message !== null)}
        className={`${INPUT} max-w-40`}
        onChange={(event) => {
          const raw = event.target.value;
          const number = Number(raw);
          onAnswer(raw === "" ? undefined : Number.isInteger(number) ? number : raw);
        }}
      />
    ) : (
      <textarea
        id={id}
        rows={3}
        maxLength={question.max_length}
        value={typeof answer === "string" ? answer : ""}
        aria-invalid={message ? true : undefined}
        aria-describedby={describedBy(id, true, message !== null)}
        className={INPUT}
        onChange={(event) => onAnswer(event.target.value === "" ? undefined : event.target.value)}
      />
    );
  const counter =
    question.type === "text"
      ? fill(text.counter, {
          length: typeof answer === "string" ? answer.length : 0,
          max: question.max_length,
        })
      : null;
  const hint = [help, counter].filter(Boolean).join(" · ");

  return (
    <div>
      <label htmlFor={id} className={LABEL}>
        {shown}
      </label>
      {hint ? (
        <p id={`${id}-hint`} className={HINT}>
          {hint}
        </p>
      ) : null}
      {field}
      {errorLine}
    </div>
  );
}
