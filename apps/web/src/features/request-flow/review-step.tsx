"use client";

import { type FormEvent, type ReactNode, useState, useTransition } from "react";

import type { Locale } from "@/i18n/config";

import { fill, PRIMARY, SECONDARY, TEXT_BUTTON } from "./fields";
import { localized, type IntakeAnswers, type IntakeQuestion } from "./questions";
import { answerText, formatDay, formatPhone } from "./review-format";
import { Actions, type Heading, ProblemBox, StepFrame } from "./step-parts";
import type {
  AddressDraft,
  ContactDraft,
  PreferredPeriod,
  RequestFlowText,
  ReviewError,
  ReviewSection,
} from "./types";

/** Where each part of the review is edited. */
export type EditTarget = "describe" | "questions" | "where" | "when" | "contact";

const EDIT_TARGET: Record<ReviewSection, EditTarget> = {
  description: "describe",
  answers: "questions",
  address: "where",
  when: "when",
  contact: "contact",
};

type ReviewStepProps = {
  text: RequestFlowText;
  locale: Locale;
  progress: string;
  heading: Heading;
  zip: string;
  description: string;
  serviceName: string | null;
  questions: readonly IntakeQuestion[];
  answers: IntakeAnswers;
  address: AddressDraft;
  date: string;
  period: PreferredPeriod;
  contact: ContactDraft;
  /** The number as it will go (E.164), for its display. */
  phone: string;
  termsHref: string;
  privacyHref: string;
  onEdit: (target: EditTarget) => void;
  onBack: () => void;
  /** Sends with the honeypot's value; answers the refusal to show here, or null when handled. */
  onSend: (website: string) => Promise<ReviewRefusal | null>;
};

/** A refusal the review words itself; too many tries may come with the API's wait. */
export type ReviewRefusal = { error: ReviewError; waitMinutes: number | null };

/** Waits longer than this read in hours (a daily cap's can be most of a day). */
const WAIT_IN_HOURS_AFTER_MINUTES = 90;

function refusalText(words: RequestFlowText["review"], refusal: ReviewRefusal): string {
  const minutes = refusal.error === "rate_limited" ? refusal.waitMinutes : null;
  if (minutes === null) return words.errors[refusal.error];
  return minutes > WAIT_IN_HOURS_AFTER_MINUTES
    ? fill(words.rateLimitedHours, { hours: Math.ceil(minutes / 60) })
    : fill(words.rateLimitedIn, { minutes });
}

/**
 * Everything the visitor gave, each part with an Edit button back to its step, then the consent
 * line and "Send to Jack". A refused send keeps every answer and says what to do; the button
 * sends once while it waits. The hidden field is a trap for scripts: people never see it.
 */
export function ReviewStep(props: ReviewStepProps) {
  const { text, locale, heading } = props;
  const words = text.review;
  const [website, setWebsite] = useState("");
  const [refusal, setRefusal] = useState<ReviewRefusal | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [pending, startTransition] = useTransition();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setRefusal(null);
    startTransition(async () => {
      let answer: ReviewRefusal | null;
      try {
        answer = await props.onSend(website);
      } catch {
        answer = { error: "unavailable", waitMinutes: null };
      }
      if (answer) {
        setRefusal(answer);
        setAttempt((count) => count + 1);
      }
    });
  }

  const answered = props.questions.flatMap((question) => {
    const shown = answerText(question, props.answers[question.key], locale, words);
    return shown === null ? [] : [[localized(question.labels, locale), shown] as const];
  });
  const { address, contact } = props;
  const message = refusal ? refusalText(words, refusal) : null;

  return (
    <StepFrame
      heading={heading}
      progress={props.progress}
      title={words.title}
      support={words.support}
    >
      <form noValidate onSubmit={submit} className="flex flex-col gap-6">
        <ProblemBox
          title={words.failedTitle}
          attempt={attempt}
          problems={message ? [{ id: null, message }] : []}
        />
        <div className="flex flex-col divide-y divide-gray-500/20 rounded-lg border-2 border-gray-500/20">
          <Part section="description" words={words} onEdit={props.onEdit}>
            <p className="whitespace-pre-wrap">{props.description.trim()}</p>
            <p className="mt-2 text-sm text-gray-500">
              {words.sections.service}: {props.serviceName ?? words.notSure}
            </p>
          </Part>
          {answered.length > 0 ? (
            <Part section="answers" words={words} onEdit={props.onEdit}>
              <dl className="flex flex-col gap-2">
                {answered.map(([question, answer]) => (
                  <div key={question}>
                    <dt className="text-sm text-gray-500">{question}</dt>
                    <dd className="whitespace-pre-wrap">{answer}</dd>
                  </div>
                ))}
              </dl>
            </Part>
          ) : null}
          <Part section="address" words={words} onEdit={props.onEdit}>
            <p>{address.line1.trim()}</p>
            {address.line2.trim() ? <p>{address.line2.trim()}</p> : null}
            <p>
              {address.city.trim()}, {address.state.trim().toUpperCase()} {props.zip}
            </p>
          </Part>
          <Part section="when" words={words} onEdit={props.onEdit}>
            <p>
              {props.date
                ? `${formatDay(props.date, locale)} · ${text.when.periods[props.period]}`
                : words.flexible}
            </p>
          </Part>
          <Part section="contact" words={words} onEdit={props.onEdit}>
            <p>{contact.firstName.trim()}</p>
            <p>{formatPhone(props.phone)}</p>
            <p>{contact.email.trim()}</p>
          </Part>
        </div>

        {/* Only a script fills this: off screen, out of the tab order, hidden from readers. */}
        <div aria-hidden="true" className="absolute -left-[9999px] h-px w-px overflow-hidden">
          <label htmlFor="request-website">{words.honeypot}</label>
          <input
            id="request-website"
            name="website"
            type="text"
            tabIndex={-1}
            autoComplete="off"
            value={website}
            onChange={(event) => setWebsite(event.target.value)}
          />
        </div>

        <p className="text-sm text-gray-500">
          {words.consent}{" "}
          <a href={props.termsHref} className={TEXT_BUTTON}>
            {words.terms}
          </a>
          {" · "}
          <a href={props.privacyHref} className={TEXT_BUTTON}>
            {words.privacy}
          </a>
        </p>
        <Actions>
          <button type="button" className={SECONDARY} onClick={props.onBack}>
            {text.back}
          </button>
          <button type="submit" aria-disabled={pending || undefined} className={PRIMARY}>
            {words.send}
          </button>
        </Actions>
        <p role="status" className="text-sm text-gray-500">
          {pending ? words.sending : ""}
        </p>
      </form>
    </StepFrame>
  );
}

function Part({
  section,
  words,
  onEdit,
  children,
}: {
  section: ReviewSection;
  words: RequestFlowText["review"];
  onEdit: (target: EditTarget) => void;
  children: ReactNode;
}) {
  const id = `review-${section}`;
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2 p-4 text-navy-900">
      <div className="flex items-baseline justify-between gap-4">
        <h3 id={id} className="font-bold">
          {words.sections[section]}
        </h3>
        <button
          type="button"
          aria-label={words.edit[section]}
          className={TEXT_BUTTON}
          onClick={() => onEdit(EDIT_TARGET[section])}
        >
          {words.editLabel}
        </button>
      </div>
      <div className="break-words">{children}</div>
    </section>
  );
}
