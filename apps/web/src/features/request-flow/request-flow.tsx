"use client";

import {
  type FormEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
  useTransition,
} from "react";

import type { Locale } from "@/i18n/config";

import {
  CHOICE,
  CHOICE_INPUT,
  describedBy,
  ERROR,
  fill,
  HINT,
  INPUT,
  LABEL,
  PRIMARY,
  SECONDARY,
  TEXT_BUTTON,
} from "./fields";
import { DESCRIPTION_MAX_LENGTH, descriptionFits, emailInput, phoneInput, zipInput } from "./input";
import { QuestionField, questionErrorText, questionFieldId } from "./question-field";
import { type IntakeAnswers, questionErrors } from "./questions";
import type { RequestCategory } from "./server";
import type {
  RequestFlowText,
  WaitlistError,
  WaitlistInput,
  WaitlistResult,
  ZipCheckResult,
  ZipError,
} from "./types";

/** The steps of the flow, in order. The waitlist is a way out of the first, not a step. */
export type StepId = "zip" | "describe" | "questions";

/** The steps a visitor goes through: the questions only for a service that asks some. */
export function stepsFor(category: RequestCategory | null): StepId[] {
  return category && category.questions.length > 0
    ? ["zip", "describe", "questions"]
    : ["zip", "describe"];
}

export type RequestFlowProps = {
  locale: Locale;
  text: RequestFlowText;
  /** The active services, or null when they could not be read (then none is offered). */
  categories: readonly RequestCategory[] | null;
  /** A service picked before the flow (a service page's link), already one of `categories`. */
  initialCategoryId: string | null;
  /** The calling code numbers are checked with (PHONE_COUNTRY_CODE). */
  countryCode: string;
  /** The home page in the page's language: where the waitlist's "done" leads. */
  homeHref: string;
  checkZip: (zip: string) => Promise<ZipCheckResult>;
  joinWaitlist: (input: WaitlistInput) => Promise<WaitlistResult>;
  /**
   * What the last step's Continue does once its answers fit. The next steps (where, when, how we
   * reach you) are not built yet (#86 W1b): without it the last step has no Continue.
   */
  onComplete?: () => void;
};

type Problem = { id: string | null; message: string };

/**
 * The web request flow (#86): one step at a time, everything kept while going back and forth.
 * Moving to a step puts the focus on its heading; a step that cannot go on lists what needs a
 * look in a box at its top (focused, each line a link to its field) and under each field.
 */
export function RequestFlow(props: RequestFlowProps) {
  const { text, categories } = props;
  const [step, setStep] = useState<StepId | "waitlist">("zip");
  const [zip, setZip] = useState("");
  const [area, setArea] = useState("");
  const [description, setDescription] = useState("");
  const [categoryId, setCategoryId] = useState(props.initialCategoryId);
  const [answers, setAnswers] = useState<Record<string, IntakeAnswers>>({});
  const [servedNow, setServedNow] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const moved = useRef(false);

  useEffect(() => {
    if (moved.current) heading.current?.focus();
  }, [step]);

  const category = categories?.find((item) => item.id === categoryId) ?? null;
  const steps = stepsFor(category);
  const go = (next: StepId | "waitlist") => {
    moved.current = true;
    setStep(next);
  };
  const progress = (id: StepId) =>
    fill(text.progress, { current: steps.indexOf(id) + 1, total: steps.length });
  const after = (id: StepId): StepId | null => steps[steps.indexOf(id) + 1] ?? null;
  const proceed = (id: StepId) => {
    const next = after(id);
    if (next) go(next);
    else props.onComplete?.();
  };
  const canProceed = (id: StepId) => after(id) !== null || props.onComplete !== undefined;

  if (step === "waitlist") {
    return (
      <Waitlist
        {...props}
        zip={area}
        categoryId={categoryId}
        heading={heading}
        onOtherZip={() => go("zip")}
        onServed={() => {
          setServedNow(true);
          go("describe");
        }}
      />
    );
  }

  if (step === "zip") {
    return (
      <ZipStep
        text={text}
        progress={progress("zip")}
        heading={heading}
        zip={zip}
        onZip={setZip}
        checkZip={props.checkZip}
        onAnswer={(result) => {
          setArea(result.zip);
          setServedNow(false);
          go(result.kind === "served" ? "describe" : "waitlist");
        }}
      />
    );
  }

  if (step === "describe") {
    return (
      <DescribeStep
        text={text}
        progress={progress("describe")}
        heading={heading}
        notice={servedNow ? fill(text.waitlist.servedNow, { zip: area }) : null}
        description={description}
        onDescription={setDescription}
        categories={categories}
        categoryId={categoryId}
        onCategory={setCategoryId}
        onBack={() => go("zip")}
        onNext={canProceed("describe") ? () => proceed("describe") : null}
      />
    );
  }

  // The questions step only exists for a service that asks some.
  const questions = category?.questions ?? [];
  const categoryAnswers = (category && answers[category.id]) ?? {};
  return (
    <QuestionsStep
      text={text}
      locale={props.locale}
      progress={progress("questions")}
      heading={heading}
      title={category?.name ?? ""}
      questions={questions}
      answers={categoryAnswers}
      onAnswer={(key, answer) => {
        if (!category) return;
        setAnswers((all) => {
          const next = { ...all[category.id] };
          if (answer === undefined) delete next[key];
          else next[key] = answer;
          return { ...all, [category.id]: next };
        });
      }}
      onBack={() => go("describe")}
      onNext={canProceed("questions") ? () => proceed("questions") : null}
    />
  );
}

type StepFrameProps = {
  heading: RefObject<HTMLHeadingElement | null>;
  progress: string | null;
  title: string;
  support: string | null;
  children: ReactNode;
};

/** A step's top: where it is in the flow, its heading (focused on arrival) and one line. */
function StepFrame({ heading, progress, title, support, children }: StepFrameProps) {
  return (
    <section aria-labelledby="request-step-title" className="flex flex-col gap-6">
      <div>
        {progress ? <p className="text-sm font-bold text-green-700">{progress}</p> : null}
        <h2
          id="request-step-title"
          ref={heading}
          tabIndex={-1}
          className="mt-1 text-2xl font-extrabold tracking-tight text-navy-900 outline-none sm:text-3xl"
        >
          {title}
        </h2>
        {support ? <p className="mt-2 text-base text-gray-500">{support}</p> : null}
      </div>
      {children}
    </section>
  );
}

/**
 * What stops the step, at its top: focused each time Continue is refused, its lines links to the
 * fields (or plain text for what no field can fix, like a service that is down).
 */
function ProblemBox({
  title,
  problems,
  attempt,
}: {
  title: string;
  problems: Problem[];
  attempt: number;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (attempt > 0) box.current?.focus();
  }, [attempt]);
  if (problems.length === 0) return null;
  return (
    <div
      ref={box}
      tabIndex={-1}
      aria-labelledby="request-problems-title"
      className="rounded-lg border-2 border-danger bg-white p-4 outline-none focus-visible:ring-2 focus-visible:ring-green-700 focus-visible:ring-offset-2"
    >
      <p id="request-problems-title" className="font-bold text-navy-900">
        {title}
      </p>
      <ul className="mt-2 flex list-disc flex-col gap-1 pl-5">
        {problems.map((problem) => (
          <li key={`${problem.id}:${problem.message}`} className="text-danger">
            {problem.id ? (
              <a href={`#${problem.id}`} className="font-semibold underline underline-offset-4">
                {problem.message}
              </a>
            ) : (
              <span className="font-semibold">{problem.message}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Actions({ children }: { children: ReactNode }) {
  return <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center">{children}</div>;
}

function ZipStep({
  text,
  progress,
  heading,
  zip,
  onZip,
  checkZip,
  onAnswer,
}: {
  text: RequestFlowText;
  progress: string;
  heading: RefObject<HTMLHeadingElement | null>;
  zip: string;
  onZip: (zip: string) => void;
  checkZip: RequestFlowProps["checkZip"];
  onAnswer: (result: Extract<ZipCheckResult, { zip: string }>) => void;
}) {
  const [error, setError] = useState<ZipError | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [pending, startTransition] = useTransition();
  const fieldError = error === "invalid" ? text.zip.errors.invalid : null;

  function refuse(next: ZipError) {
    setError(next);
    setAttempt((count) => count + 1);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const value = zipInput(zip);
    if (value === null) return refuse("invalid");
    setError(null);
    startTransition(async () => {
      let result: ZipCheckResult;
      try {
        result = await checkZip(value);
      } catch {
        result = { kind: "error", error: "unavailable" };
      }
      if (result.kind === "error") refuse(result.error);
      else onAnswer(result);
    });
  }

  return (
    <StepFrame
      heading={heading}
      progress={progress}
      title={text.zip.title}
      support={text.zip.support}
    >
      <form noValidate onSubmit={submit} className="flex flex-col gap-6">
        <ProblemBox
          title={text.check}
          attempt={attempt}
          problems={
            error
              ? [
                  {
                    id: error === "invalid" ? "request-zip" : null,
                    message: text.zip.errors[error],
                  },
                ]
              : []
          }
        />
        <div>
          <label htmlFor="request-zip" className={LABEL}>
            {text.zip.label}
          </label>
          <p id="request-zip-hint" className={HINT}>
            {text.zip.hint}
          </p>
          <input
            id="request-zip"
            name="zip"
            type="text"
            inputMode="numeric"
            autoComplete="postal-code"
            maxLength={10}
            value={zip}
            aria-invalid={fieldError ? true : undefined}
            aria-describedby={describedBy("request-zip", true, fieldError !== null)}
            className={`${INPUT} max-w-48`}
            onChange={(event) => onZip(event.target.value)}
          />
          {fieldError ? (
            <p id="request-zip-error" className={ERROR}>
              {fieldError}
            </p>
          ) : null}
        </div>
        <Actions>
          <button type="submit" aria-disabled={pending || undefined} className={PRIMARY}>
            {text.next}
          </button>
        </Actions>
        <p role="status" className="text-sm text-gray-500">
          {pending ? text.zip.checking : ""}
        </p>
      </form>
    </StepFrame>
  );
}

function DescribeStep({
  text,
  progress,
  heading,
  notice,
  description,
  onDescription,
  categories,
  categoryId,
  onCategory,
  onBack,
  onNext,
}: {
  text: RequestFlowText;
  progress: string;
  heading: RefObject<HTMLHeadingElement | null>;
  notice: string | null;
  description: string;
  onDescription: (text: string) => void;
  categories: readonly RequestCategory[] | null;
  categoryId: string | null;
  onCategory: (id: string | null) => void;
  onBack: () => void;
  onNext: (() => void) | null;
}) {
  const [missing, setMissing] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const fieldError = missing && !descriptionFits(description) ? text.describe.required : null;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!descriptionFits(description)) {
      setMissing(true);
      setAttempt((count) => count + 1);
      return;
    }
    onNext?.();
  }

  return (
    <StepFrame
      heading={heading}
      progress={progress}
      title={text.describe.title}
      support={text.describe.support}
    >
      {notice ? (
        <p role="status" className="rounded-lg bg-gray-50 px-4 py-3 font-semibold text-navy-900">
          {notice}
        </p>
      ) : null}
      <form noValidate onSubmit={submit} className="flex flex-col gap-8">
        <ProblemBox
          title={text.check}
          attempt={attempt}
          problems={fieldError ? [{ id: "request-description", message: fieldError }] : []}
        />
        <div>
          <label htmlFor="request-description" className={LABEL}>
            {text.describe.label}
          </label>
          <p id="request-description-hint" className={HINT}>
            {fill(text.counter, { length: description.length, max: DESCRIPTION_MAX_LENGTH })}
          </p>
          <textarea
            id="request-description"
            name="description"
            rows={6}
            maxLength={DESCRIPTION_MAX_LENGTH}
            value={description}
            aria-invalid={fieldError ? true : undefined}
            aria-describedby={describedBy("request-description", true, fieldError !== null)}
            className={INPUT}
            onChange={(event) => onDescription(event.target.value)}
          />
          {fieldError ? (
            <p id="request-description-error" className={ERROR}>
              {fieldError}
            </p>
          ) : null}
        </div>
        {categories && categories.length > 0 ? (
          <fieldset aria-describedby="request-category-hint">
            <legend className={LABEL}>
              {fill(text.optional, { label: text.describe.categoryLegend })}
            </legend>
            <p id="request-category-hint" className={HINT}>
              {text.describe.categoryHint}
            </p>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {[{ id: null, name: text.describe.notSure }, ...categories].map((item) => (
                <label key={item.id ?? "none"} className={CHOICE}>
                  <input
                    type="radio"
                    name="category"
                    value={item.id ?? ""}
                    checked={categoryId === item.id}
                    className={CHOICE_INPUT}
                    onChange={() => onCategory(item.id)}
                  />
                  <span className="font-semibold text-navy-900">{item.name}</span>
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}
        <Actions>
          <button type="button" className={SECONDARY} onClick={onBack}>
            {text.back}
          </button>
          {onNext ? (
            <button type="submit" className={PRIMARY}>
              {text.next}
            </button>
          ) : null}
        </Actions>
      </form>
    </StepFrame>
  );
}

function QuestionsStep({
  text,
  locale,
  progress,
  heading,
  title,
  questions,
  answers,
  onAnswer,
  onBack,
  onNext,
}: {
  text: RequestFlowText;
  locale: Locale;
  progress: string;
  heading: RefObject<HTMLHeadingElement | null>;
  title: string;
  questions: RequestCategory["questions"];
  answers: IntakeAnswers;
  onAnswer: (key: string, answer: IntakeAnswers[string] | undefined) => void;
  onBack: () => void;
  onNext: (() => void) | null;
}) {
  const [checked, setChecked] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const errors = checked ? questionErrors(questions, answers) : {};
  const problems: Problem[] = questions.flatMap((question) => {
    const error = errors[question.key];
    return error
      ? [
          {
            id: questionFieldId(question.key, question.type),
            message: questionErrorText(text.questions, error),
          },
        ]
      : [];
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (Object.keys(questionErrors(questions, answers)).length > 0) {
      setChecked(true);
      setAttempt((count) => count + 1);
      return;
    }
    onNext?.();
  }

  return (
    <StepFrame heading={heading} progress={progress} title={title} support={text.questions.support}>
      <form noValidate onSubmit={submit} className="flex flex-col gap-8">
        <ProblemBox title={text.check} attempt={attempt} problems={problems} />
        {questions.map((question) => (
          <QuestionField
            key={question.key}
            question={question}
            answer={answers[question.key]}
            error={errors[question.key]}
            locale={locale}
            text={text}
            onAnswer={(answer) => onAnswer(question.key, answer)}
          />
        ))}
        <Actions>
          <button type="button" className={SECONDARY} onClick={onBack}>
            {text.back}
          </button>
          {onNext ? (
            <button type="submit" className={PRIMARY}>
              {text.next}
            </button>
          ) : null}
        </Actions>
      </form>
    </StepFrame>
  );
}

function Waitlist({
  text,
  locale,
  countryCode,
  homeHref,
  joinWaitlist,
  zip,
  categoryId,
  heading,
  onOtherZip,
  onServed,
}: RequestFlowProps & {
  zip: string;
  categoryId: string | null;
  heading: RefObject<HTMLHeadingElement | null>;
  onOtherZip: () => void;
  onServed: () => void;
}) {
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<WaitlistError | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [joined, setJoined] = useState(false);
  const [pending, startTransition] = useTransition();
  const words = text.waitlist;

  useEffect(() => {
    if (joined) heading.current?.focus();
  }, [joined, heading]);

  function refuse(next: WaitlistError) {
    setError(next);
    setAttempt((count) => count + 1);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const emailText = email.trim();
    const phoneText = phone.trim();
    if (emailText === "" && phoneText === "") return refuse("missing_contact");
    if (emailText !== "" && emailInput(emailText) === null) return refuse("invalid_email");
    if (phoneText !== "" && phoneInput(phoneText, countryCode) === null)
      return refuse("invalid_phone");
    setError(null);
    startTransition(async () => {
      let result: WaitlistResult;
      try {
        result = await joinWaitlist({
          zip,
          email: emailText,
          phone: phoneText,
          categoryId,
          locale,
        });
      } catch {
        result = { kind: "error", error: "unavailable" };
      }
      if (result.kind === "joined") setJoined(true);
      else if (result.kind === "zip_served") onServed();
      else refuse(result.error);
    });
  }

  if (joined) {
    return (
      <StepFrame
        heading={heading}
        progress={null}
        title={words.joinedTitle}
        support={fill(words.joinedBody, { zip })}
      >
        <Actions>
          <a href={homeHref} className={PRIMARY}>
            {words.home}
          </a>
        </Actions>
      </StepFrame>
    );
  }

  const emailError = error === "invalid_email" ? words.errors.invalid_email : null;
  const phoneError = error === "invalid_phone" ? words.errors.invalid_phone : null;
  const both = error === "missing_contact" || error === "invalid";
  const problemId =
    error === "invalid_email" || error === "missing_contact" || error === "invalid"
      ? "request-waitlist-email"
      : error === "invalid_phone"
        ? "request-waitlist-phone"
        : null;

  return (
    <StepFrame
      heading={heading}
      progress={null}
      title={words.title}
      support={fill(words.body, { zip })}
    >
      <form noValidate onSubmit={submit} className="flex flex-col gap-6">
        <ProblemBox
          title={text.check}
          attempt={attempt}
          problems={error ? [{ id: problemId, message: words.errors[error] }] : []}
        />
        <p id="request-waitlist-contact-hint" className="text-base font-semibold text-navy-900">
          {words.contactHint}
        </p>
        <div>
          <label htmlFor="request-waitlist-email" className={LABEL}>
            {words.emailLabel}
          </label>
          <input
            id="request-waitlist-email"
            name="email"
            type="email"
            autoComplete="email"
            maxLength={320}
            value={email}
            aria-invalid={emailError || both ? true : undefined}
            aria-describedby={[
              "request-waitlist-contact-hint",
              emailError ? "request-waitlist-email-error" : null,
            ]
              .filter(Boolean)
              .join(" ")}
            className={INPUT}
            onChange={(event) => setEmail(event.target.value)}
          />
          {emailError ? (
            <p id="request-waitlist-email-error" className={ERROR}>
              {emailError}
            </p>
          ) : null}
        </div>
        <div>
          <label htmlFor="request-waitlist-phone" className={LABEL}>
            {words.phoneLabel}
          </label>
          <input
            id="request-waitlist-phone"
            name="phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel-national"
            maxLength={40}
            value={phone}
            aria-invalid={phoneError || both ? true : undefined}
            aria-describedby={[
              "request-waitlist-contact-hint",
              phoneError ? "request-waitlist-phone-error" : null,
            ]
              .filter(Boolean)
              .join(" ")}
            className={`${INPUT} max-w-72`}
            onChange={(event) => setPhone(event.target.value)}
          />
          {phoneError ? (
            <p id="request-waitlist-phone-error" className={ERROR}>
              {phoneError}
            </p>
          ) : null}
        </div>
        <p className="text-sm text-gray-500">{words.use}</p>
        <Actions>
          <button type="submit" aria-disabled={pending || undefined} className={PRIMARY}>
            {words.submit}
          </button>
        </Actions>
        <p role="status" className="text-sm text-gray-500">
          {pending ? words.sending : ""}
        </p>
        <p>
          <button type="button" className={TEXT_BUTTON} onClick={onOtherZip}>
            {words.otherZip}
          </button>
        </p>
      </form>
    </StepFrame>
  );
}
