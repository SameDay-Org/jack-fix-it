"use client";

import { type FormEvent, useEffect, useRef, useState, useTransition } from "react";

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
import {
  dayInput,
  DESCRIPTION_MAX_LENGTH,
  descriptionFits,
  emailInput,
  firstDay,
  phoneInput,
  zipInput,
} from "./input";
import { QuestionField, questionErrorText, questionFieldId } from "./question-field";
import { type IntakeAnswers, intakeAnswersFor, questionErrors } from "./questions";
import type { ReviewRefusal } from "./review-step";
import type { RequestCategory } from "./server";
import { addressErrors, contactErrors } from "./step-checks";
import { Actions, type Heading, type Problem, ProblemBox, StepFrame } from "./step-parts";
import type {
  AddressDraft,
  ContactDraft,
  PreferredPeriod,
  RequestDraft,
  RequestFlowText,
  SendInput,
  SendResult,
  StoreLinks,
  Utm,
  WaitlistError,
  WaitlistInput,
  WaitlistResult,
  ZipCheckResult,
  ZipError,
} from "./types";

/** The steps of the flow, in order. The waitlist is a way out of the first, not a step. */
export type StepId = "zip" | "describe" | "questions" | "where" | "when" | "contact" | "review";

/** The steps a visitor goes through: the questions only for a service that asks some. */
export function stepsFor(category: RequestCategory | null): StepId[] {
  const questions: StepId[] = category && category.questions.length > 0 ? ["questions"] : [];
  return ["zip", "describe", ...questions, "where", "when", "contact", "review"];
}

/** What the flow can show: a step, the waitlist, or the end (sent, or put on the waitlist). */
type Screen = StepId | "waitlist" | "done";
const SCREENS: readonly Screen[] = [
  "zip",
  "describe",
  "questions",
  "where",
  "when",
  "contact",
  "review",
  "waitlist",
  "done",
];

/**
 * The query parameter that names the screen (none for the ZIP step), so the browser's Back and
 * Forward move between the screens the visitor saw, instead of leaving the page (#86).
 */
export const STEP_PARAM = "step";

function screenOf(search: string): Screen {
  const value = new URLSearchParams(search).get(STEP_PARAM);
  return SCREENS.find((screen) => screen === value) ?? "zip";
}

/** The key, in a history entry's state, of the page load that made the entry. */
const FLOW_STATE_KEY = "jfiRequestFlow";

/** An id for this page load's entries: not a secret, only different from an earlier load's. */
function newLoadId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * A history entry's state with this page load's mark, keeping whatever else it holds: the
 * router keeps its own keys there, and an entry without them makes it reload the page on Back.
 * (The page's first write can come before the router wraps the History API.)
 */
function entryState(load: string): Record<string, unknown> {
  const current: unknown = window.history.state;
  const kept = typeof current === "object" && current !== null ? current : {};
  return { ...kept, [FLOW_STATE_KEY]: load };
}

/** Whether a history entry was made by this page load. */
function isOwnEntry(state: unknown, load: string): boolean {
  return (
    typeof state === "object" &&
    state !== null &&
    (state as Record<string, unknown>)[FLOW_STATE_KEY] === load
  );
}

/** This page's address with `screen` in its query; every other parameter is kept. */
function screenUrl(screen: Screen): string {
  const url = new URL(window.location.href);
  if (screen === "zip") url.searchParams.delete(STEP_PARAM);
  else url.searchParams.set(STEP_PARAM, screen);
  return `${url.pathname}${url.search}${url.hash}`;
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
  /** The signed form token (lib/public-form), minted with the page; a refused send may renew it. */
  formToken: string;
  /** Where the visitor came from (attribution.ts), sent with the request. */
  utm: Utm | null;
  /** The app's store pages, once set (config.ts); else the sent screen links to `appHref`. */
  storeLinks: StoreLinks | null;
  appHref: string;
  /** The home page in the page's language: where the waitlist's and the sent screen's "done" lead. */
  homeHref: string;
  termsHref: string;
  privacyHref: string;
  checkZip: (zip: string) => Promise<ZipCheckResult>;
  joinWaitlist: (input: WaitlistInput) => Promise<WaitlistResult>;
  sendRequest: (input: SendInput) => Promise<SendResult>;
};

const EMPTY_ADDRESS: AddressDraft = { line1: "", line2: "", city: "", state: "" };
const EMPTY_CONTACT: ContactDraft = { firstName: "", phone: "", email: "" };

/** The steps after the description, loaded apart from the page (later-steps.ts). */
type LaterSteps = typeof import("./later-steps");
const loadLaterSteps = (): Promise<LaterSteps> => import("./later-steps");
const LATER_SCREENS: readonly Screen[] = ["where", "when", "contact", "review", "done"];

/** How the flow ended: sent (with its number; none for the trap field), or on the waitlist. */
type Finished = { kind: "sent"; code: string | null } | { kind: "waitlisted" };

/** A day the API takes: none (any day), or today or later. */
function dayFits(date: string): boolean {
  return date === "" || dayInput(date, firstDay(new Date())) !== null;
}

/**
 * The web request flow (#86): one step at a time, everything kept while going back and forth
 * and after a refused send. Moving to a step puts the focus on its heading; a step that cannot
 * go on lists what needs a look in a box at its top (focused, each line a link to its field)
 * and under each field. A refusal the visitor can fix sends them to its step with a line saying
 * why.
 */
export function RequestFlow(props: RequestFlowProps) {
  const { text, categories } = props;
  const [screen, setScreen] = useState<Screen>("zip");
  const [notice, setNotice] = useState<string | null>(null);
  const [zip, setZip] = useState("");
  const [area, setArea] = useState("");
  /** The last ZIP check's answer for `area`: served or not; null before any. */
  const [served, setServed] = useState<boolean | null>(null);
  const [description, setDescription] = useState("");
  const [categoryId, setCategoryId] = useState(props.initialCategoryId);
  const [answers, setAnswers] = useState<Record<string, IntakeAnswers>>({});
  const [address, setAddress] = useState(EMPTY_ADDRESS);
  const [date, setDate] = useState("");
  const [period, setPeriod] = useState<PreferredPeriod>("flexible");
  const [contact, setContact] = useState(EMPTY_CONTACT);
  const [token, setToken] = useState(props.formToken);
  const [finished, setFinished] = useState<Finished | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const moved = useRef(false);

  const [later, setLater] = useState<LaterSteps | null>(null);
  const needsLater = LATER_SCREENS.includes(screen);
  // Asked for as soon as the flow shows, so they are there long before the visitor is; asked
  // again on reaching one of them if that first try failed.
  useEffect(() => {
    if (later) return;
    let live = true;
    loadLaterSteps().then(
      (steps) => {
        if (live) setLater(steps);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [later, needsLater]);
  /** Whether the screen itself shows (a later step waits for its code). */
  const shown = !needsLater || later !== null;

  useEffect(() => {
    if (moved.current) heading.current?.focus();
  }, [screen, shown]);

  const category = categories?.find((item) => item.id === categoryId) ?? null;
  const questions = category?.questions ?? [];
  const categoryAnswers = (category && answers[category.id]) ?? {};
  const steps = stepsFor(category);
  /** Whether a step's answers would go on: what the steps after it need. */
  const fits = (id: StepId): boolean => {
    switch (id) {
      case "zip":
        return served === true;
      case "describe":
        return descriptionFits(description);
      case "questions":
        return Object.keys(questionErrors(questions, categoryAnswers)).length === 0;
      case "where":
        return addressErrors(address).length === 0;
      case "when":
        return dayFits(date);
      case "contact":
        return contactErrors(contact, props.countryCode).length === 0;
      case "review":
        return true;
    }
  };
  /**
   * Whether `target` can show with what the visitor has given so far: a step once every step
   * before it would go on; the waitlist for an unserved ZIP; the end only once it is reached,
   * and then nothing else (Back leaves a sent request rather than offer to send it again).
   */
  const reachable = (target: Screen): boolean => {
    if (finished) return target === "done";
    if (target === "done") return false;
    if (target === "waitlist") return served === false;
    const at = steps.indexOf(target);
    return at >= 0 && steps.slice(0, at).every(fits);
  };
  // Each move is a history entry of this page load (marked with its id), so the browser's Back
  // and Forward go through the screens the visitor saw. A screen that cannot show any more (a
  // ZIP checked again, an answer emptied, another service, a request sent) is passed over with
  // one more step back: going back, that reaches the screen before it; going forward, the
  // screen the visitor was on.
  const [load] = useState(newLoadId);
  /** To `next`, with a line about why when there is one to say. */
  const go = (next: Screen, why: string | null = null) => {
    moved.current = true;
    window.history.pushState(entryState(load), "", screenUrl(next));
    setNotice(why);
    setScreen(next);
  };
  const latest = useRef({ screen, reachable });
  useEffect(() => {
    latest.current = { screen, reachable };
  });
  useEffect(() => {
    // Nothing typed survives a reload: the page starts again at the ZIP, whatever the address
    // named, and this entry becomes the first of this page load.
    const path = window.location.pathname;
    window.history.replaceState(entryState(load), "", screenUrl("zip"));
    function onPopState(event: PopStateEvent) {
      if (window.location.pathname !== path) return; // another page: not the flow's to handle
      const target = screenOf(window.location.search);
      const { screen: current, reachable: canShow } = latest.current;
      // A screen from before a reload (nothing it showed is kept), or one that cannot show any
      // more: one more step back passes over it.
      if (!isOwnEntry(event.state, load) || !canShow(target)) {
        window.history.back();
        return;
      }
      if (target === current) return;
      moved.current = true;
      setNotice(null);
      setScreen(target);
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [load]);
  const progress = (id: StepId) =>
    fill(text.progress, { current: steps.indexOf(id) + 1, total: steps.length });

  /** Sends, and answers the refusal the review shows itself, or null once it was handled. */
  async function send(website: string): Promise<ReviewRefusal | null> {
    const draft: RequestDraft = {
      zip: area,
      description,
      categoryId: category?.id ?? null,
      answers: intakeAnswersFor(questions, categoryAnswers),
      address,
      date,
      period,
      contact,
      locale: props.locale,
      utm: props.utm,
    };
    const result = await props.sendRequest({ token, website, draft });
    if (result.kind === "sent") {
      setFinished({ kind: "sent", code: result.code });
      go("done");
      return null;
    }
    if (result.token) setToken(result.token);
    switch (result.error) {
      case "out_of_area":
        // No request: the API put the contact on the ZIP's waitlist.
        setServed(false);
        setFinished({ kind: "waitlisted" });
        go("done");
        return null;
      case "invalid_category":
        setCategoryId(null);
        go("describe", text.notices.invalidCategory);
        return null;
      case "invalid_answers":
        go(questions.length > 0 ? "questions" : "describe", text.notices.invalidAnswers);
        return null;
      default:
        return { error: result.error, waitMinutes: result.waitMinutes ?? null };
    }
  }

  /** A screen after the description, with its code loaded. */
  function laterScreen(steps: LaterSteps) {
    switch (screen) {
      case "done":
        if (finished?.kind === "waitlisted") {
          return (
            <steps.WaitlistedScreen
              text={text}
              heading={heading}
              zip={area}
              homeHref={props.homeHref}
            />
          );
        }
        return (
          <steps.SentScreen
            text={text}
            heading={heading}
            code={finished?.code ?? null}
            storeLinks={props.storeLinks}
            appHref={props.appHref}
            homeHref={props.homeHref}
          />
        );
      case "where":
        return (
          <steps.WhereStep
            text={text}
            progress={progress("where")}
            heading={heading}
            zip={area}
            address={address}
            onAddress={setAddress}
            onChangeZip={() => go("zip")}
            onBack={() => go(questions.length > 0 ? "questions" : "describe")}
            onNext={() => go("when")}
          />
        );
      case "when":
        return (
          <steps.WhenStep
            text={text}
            progress={progress("when")}
            heading={heading}
            date={date}
            period={period}
            onDate={setDate}
            onPeriod={setPeriod}
            onBack={() => go("where")}
            onNext={() => go("contact")}
          />
        );
      case "contact":
        return (
          <steps.ContactStep
            text={text}
            progress={progress("contact")}
            heading={heading}
            notice={notice}
            countryCode={props.countryCode}
            contact={contact}
            onContact={setContact}
            onBack={() => go("when")}
            onNext={() => go("review")}
          />
        );
      case "review":
        return (
          <steps.ReviewStep
            text={text}
            locale={props.locale}
            progress={progress("review")}
            heading={heading}
            zip={area}
            description={description}
            serviceName={category?.name ?? null}
            questions={questions}
            answers={categoryAnswers}
            address={address}
            date={date}
            period={period}
            contact={contact}
            phone={phoneInput(contact.phone, props.countryCode) ?? contact.phone}
            termsHref={props.termsHref}
            privacyHref={props.privacyHref}
            onEdit={(target) => go(target)}
            onBack={() => go("contact")}
            onSend={send}
          />
        );
      default:
        return null;
    }
  }

  if (needsLater) {
    if (!later) {
      return (
        <StepFrame heading={heading} progress={null} title={text.loading} support={null}>
          {null}
        </StepFrame>
      );
    }
    return laterScreen(later);
  }

  switch (screen) {
    case "waitlist":
      return (
        <Waitlist
          {...props}
          zip={area}
          categoryId={categoryId}
          heading={heading}
          onOtherZip={() => go("zip")}
          onServed={() => {
            setServed(true);
            go("describe", fill(text.waitlist.servedNow, { zip: area }));
          }}
        />
      );
    case "zip":
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
            setServed(result.kind === "served");
            if (result.kind === "served") {
              // The served city fills in an empty address; what the visitor typed stays.
              setAddress((current) => ({
                ...current,
                city: current.city || (result.city ?? ""),
                state: current.state || (result.state ?? ""),
              }));
            }
            go(result.kind === "served" ? "describe" : "waitlist");
          }}
        />
      );
    case "describe":
      return (
        <DescribeStep
          text={text}
          progress={progress("describe")}
          heading={heading}
          notice={notice}
          description={description}
          onDescription={setDescription}
          categories={categories}
          categoryId={categoryId}
          onCategory={setCategoryId}
          onBack={() => go("zip")}
          onNext={() => go(questions.length > 0 ? "questions" : "where")}
        />
      );
    case "questions":
      return (
        <QuestionsStep
          text={text}
          locale={props.locale}
          progress={progress("questions")}
          heading={heading}
          notice={notice}
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
          onNext={() => go("where")}
        />
      );
    default:
      return null;
  }
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
  heading: Heading;
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
  heading: Heading;
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
      notice={notice}
    >
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
  notice,
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
  heading: Heading;
  notice: string | null;
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
    <StepFrame
      heading={heading}
      progress={progress}
      title={title}
      support={text.questions.support}
      notice={notice}
    >
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
  heading: Heading;
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
