"use client";

import { type FormEvent, useState } from "react";

import { CHOICE, CHOICE_INPUT, fill, LABEL, PRIMARY, SECONDARY } from "./fields";
import { dayInput, firstDay } from "./input";
import { Actions, type Heading, ProblemBox, StepFrame, TextField } from "./step-parts";
import type { PreferredPeriod, RequestFlowText } from "./types";

const PERIODS: readonly PreferredPeriod[] = ["flexible", "morning", "afternoon", "evening"];

/**
 * When it suits the visitor: a day (or none: any day works) and, with a day, a time of it. The
 * first day offered is today on the visitor's calendar or in UTC, whichever is later (the API
 * refuses a day before today in UTC).
 */
export function WhenStep({
  text,
  progress,
  heading,
  date,
  period,
  onDate,
  onPeriod,
  onBack,
  onNext,
}: {
  text: RequestFlowText;
  progress: string;
  heading: Heading;
  date: string;
  period: PreferredPeriod;
  onDate: (date: string) => void;
  onPeriod: (period: PreferredPeriod) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  // The first day is fixed when the step opens: a page left open past midnight still refuses
  // yesterday on the server.
  const [first] = useState(() => firstDay(new Date()));
  const [checked, setChecked] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const words = text.when;
  const wrong = (value: string) => value !== "" && dayInput(value, first) === null;
  const error = checked && wrong(date) ? words.errors.day : null;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (wrong(date)) {
      setChecked(true);
      setAttempt((count) => count + 1);
      return;
    }
    onNext();
  }

  return (
    <StepFrame heading={heading} progress={progress} title={words.title} support={words.support}>
      <form noValidate onSubmit={submit} className="flex flex-col gap-6">
        <ProblemBox
          title={text.check}
          attempt={attempt}
          problems={error ? [{ id: "request-day", message: error }] : []}
        />
        <TextField
          id="request-day"
          type="date"
          label={fill(text.optional, { label: words.day })}
          hint={words.dayHint}
          min={first}
          className="max-w-60"
          value={date}
          error={error}
          onChange={onDate}
        />
        {date !== "" ? (
          <fieldset>
            <legend className={LABEL}>{words.period}</legend>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {PERIODS.map((value) => (
                <label key={value} className={CHOICE}>
                  <input
                    type="radio"
                    name="period"
                    value={value}
                    checked={period === value}
                    className={CHOICE_INPUT}
                    onChange={() => onPeriod(value)}
                  />
                  <span className="font-semibold text-navy-900">{words.periods[value]}</span>
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}
        <Actions>
          <button type="button" className={SECONDARY} onClick={onBack}>
            {text.back}
          </button>
          <button type="submit" className={PRIMARY}>
            {text.next}
          </button>
        </Actions>
      </form>
    </StepFrame>
  );
}
