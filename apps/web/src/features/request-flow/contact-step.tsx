"use client";

import { type FormEvent, useState } from "react";

import { PRIMARY, SECONDARY } from "./fields";
import { EMAIL_MAX_LENGTH, NAME_MAX_LENGTH } from "./input";
import {
  Actions,
  type Heading,
  type Problem,
  ProblemBox,
  StepFrame,
  TextField,
} from "./step-parts";
import { type ContactField, contactErrors } from "./step-checks";
import type { ContactDraft, RequestFlowText } from "./types";

const FIELD_IDS: Record<ContactField, string> = {
  firstName: "request-first-name",
  phone: "request-phone",
  email: "request-email",
};

/**
 * Who the BDC calls back (#86, POST /v1/web/requests: `contact`): the first name, the mobile
 * number and the email, all three required by the API. Contacts are for the team only: pros
 * never see them.
 */
export function ContactStep({
  text,
  progress,
  heading,
  notice,
  countryCode,
  contact,
  onContact,
  onBack,
  onNext,
}: {
  text: RequestFlowText;
  progress: string;
  heading: Heading;
  notice: string | null;
  countryCode: string;
  contact: ContactDraft;
  onContact: (contact: ContactDraft) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const [checked, setChecked] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const words = text.contact;
  const errors = checked ? contactErrors(contact, countryCode) : [];
  const error = (field: ContactField) => (errors.includes(field) ? words.errors[field] : null);
  const problems: Problem[] = errors.map((field) => ({
    id: FIELD_IDS[field],
    message: words.errors[field],
  }));
  const set = (field: keyof ContactDraft) => (value: string) =>
    onContact({ ...contact, [field]: value });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (contactErrors(contact, countryCode).length > 0) {
      setChecked(true);
      setAttempt((count) => count + 1);
      return;
    }
    onNext();
  }

  return (
    <StepFrame
      heading={heading}
      progress={progress}
      title={words.title}
      support={words.support}
      notice={notice}
    >
      <form noValidate onSubmit={submit} className="flex flex-col gap-6">
        <ProblemBox title={text.check} attempt={attempt} problems={problems} />
        <TextField
          id={FIELD_IDS.firstName}
          label={words.firstName}
          autoComplete="given-name"
          maxLength={NAME_MAX_LENGTH}
          className="max-w-96"
          value={contact.firstName}
          error={error("firstName")}
          onChange={set("firstName")}
        />
        <TextField
          id={FIELD_IDS.phone}
          type="tel"
          inputMode="tel"
          label={words.phone}
          hint={words.phoneHint}
          autoComplete="tel-national"
          maxLength={40}
          className="max-w-72"
          value={contact.phone}
          error={error("phone")}
          onChange={set("phone")}
        />
        <TextField
          id={FIELD_IDS.email}
          type="email"
          label={words.email}
          autoComplete="email"
          maxLength={EMAIL_MAX_LENGTH}
          value={contact.email}
          error={error("email")}
          onChange={set("email")}
        />
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
