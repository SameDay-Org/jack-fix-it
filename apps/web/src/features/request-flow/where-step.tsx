"use client";

import { type FormEvent, useState } from "react";

import { fill, PRIMARY, SECONDARY, TEXT_BUTTON } from "./fields";
import { CITY_MAX_LENGTH, LINE_MAX_LENGTH } from "./input";
import {
  Actions,
  type Heading,
  type Problem,
  ProblemBox,
  StepFrame,
  TextField,
} from "./step-parts";
import { type AddressField, addressErrors } from "./step-checks";
import type { AddressDraft, RequestFlowText } from "./types";

/**
 * Where the job is: the street, the unit, the city and the state, the ZIP already checked (a
 * link changes it). The city and state come filled in when the ZIP belongs to one served city.
 */
export function WhereStep({
  text,
  progress,
  heading,
  zip,
  address,
  onAddress,
  onChangeZip,
  onBack,
  onNext,
}: {
  text: RequestFlowText;
  progress: string;
  heading: Heading;
  zip: string;
  address: AddressDraft;
  onAddress: (address: AddressDraft) => void;
  onChangeZip: () => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const [checked, setChecked] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const words = text.where;
  const errors = checked ? addressErrors(address) : [];
  const error = (field: AddressField) => (errors.includes(field) ? words.errors[field] : null);
  const problems: Problem[] = errors.map((field) => ({
    id: `request-${field}`,
    message: words.errors[field],
  }));
  const set = (field: keyof AddressDraft) => (value: string) =>
    onAddress({ ...address, [field]: value });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (addressErrors(address).length > 0) {
      setChecked(true);
      setAttempt((count) => count + 1);
      return;
    }
    onNext();
  }

  return (
    <StepFrame heading={heading} progress={progress} title={words.title} support={words.support}>
      <form noValidate onSubmit={submit} className="flex flex-col gap-6">
        <ProblemBox title={text.check} attempt={attempt} problems={problems} />
        <TextField
          id="request-line1"
          label={words.line1}
          autoComplete="address-line1"
          maxLength={LINE_MAX_LENGTH}
          value={address.line1}
          error={error("line1")}
          onChange={set("line1")}
        />
        <TextField
          id="request-line2"
          label={fill(text.optional, { label: words.line2 })}
          autoComplete="address-line2"
          maxLength={LINE_MAX_LENGTH}
          value={address.line2}
          error={null}
          onChange={set("line2")}
        />
        <div className="grid gap-6 sm:grid-cols-[minmax(0,1fr)_8rem]">
          <TextField
            id="request-city"
            label={words.city}
            autoComplete="address-level2"
            maxLength={CITY_MAX_LENGTH}
            value={address.city}
            error={error("city")}
            onChange={set("city")}
          />
          <TextField
            id="request-state"
            label={words.state}
            hint={words.stateHint}
            autoComplete="address-level1"
            autoCapitalize="characters"
            maxLength={2}
            className="max-w-24 uppercase"
            value={address.state}
            error={error("state")}
            onChange={set("state")}
          />
        </div>
        <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-base text-navy-900">
          <span className="font-bold">{fill(words.zip, { zip })}</span>
          <button type="button" className={TEXT_BUTTON} onClick={onChangeZip}>
            {words.changeZip}
          </button>
        </p>
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
