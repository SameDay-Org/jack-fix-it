"use client";

import { useRouter } from "next/navigation";
import {
  type FormEvent,
  startTransition,
  useActionState,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/input";

import type { ResolveState } from "../actions";
import {
  type AmountError,
  amountError,
  type Decision,
  DECISIONS,
  dollarsToCents,
  formatMoney,
  NOTE_MAX_LENGTH,
  type ResolveError,
} from "../disputes";

export type ResolveControlText = {
  title: string;
  decisionLabel: string;
  decisions: Record<Decision, { label: string; hint: string }>;
  decisionError: string;
  amountLabel: string;
  amountHint: string;
  amountErrors: Record<AmountError, string>;
  noteLabel: string;
  noteHint: string;
  noteError: string;
  review: string;
  confirmTitle: string;
  /** The API's frozen totals, already written out: "Customer paid $X, pro payout $Y." */
  totals: string;
  /** The decision in words; the partial's has `{{amount}}`, the amount typed. */
  sentences: Record<Decision, string>;
  codeLabel: string;
  codeHint: string;
  submit: string;
  back: string;
  resolving: string;
  resolved: string;
  errors: Record<ResolveError, string>;
};

/** A refund and a split give money back: the admin types the dispute's code to confirm them. */
const NEEDS_CODE: ReadonlySet<Decision> = new Set<Decision>(["partial", "refund"]);

const FIELD =
  "w-full rounded-md border border-gray-500/30 bg-white px-4 py-3 text-base text-navy-900 outline-none focus-visible:border-green-700 focus-visible:ring-2 focus-visible:ring-green-700/30 aria-invalid:border-danger";

type Problems = { decision?: true; amount?: AmountError; note?: true };

const initialState: ResolveState = { error: null, resolved: false };

/**
 * An admin's resolution of a dispute, in two steps (#83). First the decision (release, split
 * or refund), a split's amount in dollars and the staff-only note, checked as the API checks
 * them. Then the decision in words with the API's frozen totals; a refund or a split also asks
 * for the dispute's code, typed again, before Confirm does anything. No money is computed
 * here: the split's amount is what the admin typed, and every other amount is the API's.
 *
 * One confirmation sends one request: Confirm does nothing while a request is out. A request
 * that never answered (a dropped connection) is not sent again: the page is read again and
 * says to check the dispute first. Confirm is never `disabled`, so the keyboard focus never
 * lands on a dead control: it says it is unavailable (`aria-disabled`) and ignores a press.
 */
export function ResolveControl({
  action,
  code,
  payoutCents,
  currency,
  locale,
  text,
}: {
  action: (previous: ResolveState, form: FormData) => Promise<ResolveState>;
  /** The dispute's public code, to type again. */
  code: string;
  payoutCents: number;
  currency: string | null;
  locale: string;
  text: ResolveControlText;
}) {
  const router = useRouter();
  const [step, setStep] = useState<"edit" | "confirm">("edit");
  const [decision, setDecision] = useState<Decision | null>(null);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [typedCode, setTypedCode] = useState("");
  const [problems, setProblems] = useState<Problems>({});
  const [offline, setOffline] = useState(false);
  const sending = useRef(false);
  const id = useId();
  const confirmHeading = useRef<HTMLHeadingElement>(null);
  const reviewButton = useRef<HTMLButtonElement>(null);
  const errorBox = useRef<HTMLParagraphElement>(null);
  // Where the focus goes once the next render is on screen.
  const focusNext = useRef<"confirm" | "review" | "error" | null>(null);
  const [state, dispatch, pending] = useActionState(
    async (previous: ResolveState, form: FormData): Promise<ResolveState> => {
      let result: ResolveState;
      try {
        result = await action(previous, form);
      } catch {
        // The request never answered: it may have gone through. Read the page again; never
        // send it again from here.
        router.refresh();
        result = { error: "unconfirmed", resolved: false };
      }
      // Confirm may send again. A refusal takes the admin back to the first step, with what
      // they typed (the code is asked again).
      sending.current = false;
      if (result.error) {
        setStep("edit");
        setTypedCode("");
        focusNext.current = "error";
      }
      return result;
    },
    initialState,
  );

  const cents = decision === "partial" ? dollarsToCents(amount) : null;
  const codeMatches = typedCode.trim().toUpperCase() === code.toUpperCase();
  const blocked = pending || (decision !== null && NEEDS_CODE.has(decision) && !codeMatches);
  const error = offline ? "offline" : state.error;

  // After a render: the confirmation's heading (the decision in words is read first), Review
  // after Back, or a refusal's message.
  useEffect(() => {
    const target = focusNext.current;
    if (!target) return;
    const element = { confirm: confirmHeading, review: reviewButton, error: errorBox }[target]
      .current;
    if (!element) return; // not on screen yet: after the next render
    focusNext.current = null;
    element.focus();
  });

  const review = () => {
    if (pending) return;
    const found: Problems = {};
    if (!decision) found.decision = true;
    if (decision === "partial") {
      const problem = amountError(dollarsToCents(amount), payoutCents);
      if (problem) found.amount = problem;
    }
    if (note.trim() === "") found.note = true;
    setProblems(found);
    setOffline(false);
    if (Object.keys(found).length > 0) {
      const first = found.decision
        ? `${id}-${DECISIONS[0]}`
        : found.amount
          ? `${id}-amount`
          : `${id}-note`;
      document.getElementById(first)?.focus();
      return;
    }
    setStep("confirm");
    setTypedCode("");
    focusNext.current = "confirm";
  };

  const back = () => {
    if (pending) return;
    setStep("edit");
    focusNext.current = "review";
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (step !== "confirm" || blocked || sending.current) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      setOffline(true);
      setStep("edit");
      focusNext.current = "error";
      return;
    }
    setOffline(false);
    sending.current = true;
    const form = new FormData(event.currentTarget);
    startTransition(() => dispatch(form));
  };

  const sentence =
    decision === "partial" && cents !== null
      ? text.sentences.partial.replace("{{amount}}", formatMoney(cents, currency, locale))
      : decision
        ? text.sentences[decision]
        : "";

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      {step === "edit" ? (
        <>
          <fieldset
            className="flex flex-col gap-2"
            aria-describedby={problems.decision ? `${id}-decision-error` : undefined}
          >
            <legend className="mb-2 text-sm font-semibold">{text.decisionLabel}</legend>
            {DECISIONS.map((value) => (
              <label
                key={value}
                htmlFor={`${id}-${value}`}
                className="flex cursor-pointer gap-3 rounded-md border border-gray-500/30 bg-white p-3 has-checked:border-green-700 has-checked:ring-2 has-checked:ring-green-700/30"
              >
                <input
                  id={`${id}-${value}`}
                  type="radio"
                  name="decision-choice"
                  value={value}
                  checked={decision === value}
                  onChange={() => setDecision(value)}
                  aria-describedby={`${id}-${value}-hint`}
                  className="mt-1 size-4 accent-green-700"
                />
                <span className="flex flex-col gap-1">
                  <span className="font-semibold">{text.decisions[value].label}</span>
                  <span id={`${id}-${value}-hint`} className="text-sm text-gray-500">
                    {text.decisions[value].hint}
                  </span>
                </span>
              </label>
            ))}
            {problems.decision ? (
              <p id={`${id}-decision-error`} className="text-sm font-semibold text-danger">
                {text.decisionError}
              </p>
            ) : null}
          </fieldset>
          {decision === "partial" ? (
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${id}-amount`}>{text.amountLabel}</Label>
              <input
                id={`${id}-amount`}
                type="text"
                inputMode="decimal"
                autoComplete="off"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                aria-invalid={problems.amount ? true : undefined}
                aria-describedby={`${id}-amount-hint${problems.amount ? ` ${id}-amount-error` : ""}`}
                className={`${FIELD} max-w-48 tabular-nums`}
              />
              <p id={`${id}-amount-hint`} className="text-sm text-gray-500">
                {text.amountHint}
              </p>
              {problems.amount ? (
                <p id={`${id}-amount-error`} className="text-sm font-semibold text-danger">
                  {text.amountErrors[problems.amount]}
                </p>
              ) : null}
            </div>
          ) : null}
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${id}-note`}>{text.noteLabel}</Label>
            <textarea
              id={`${id}-note`}
              rows={3}
              maxLength={NOTE_MAX_LENGTH}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              aria-invalid={problems.note ? true : undefined}
              aria-describedby={`${id}-note-hint${problems.note ? ` ${id}-note-error` : ""}`}
              className={FIELD}
            />
            <p id={`${id}-note-hint`} className="text-sm text-gray-500">
              {text.noteHint}
            </p>
            {problems.note ? (
              <p id={`${id}-note-error`} className="text-sm font-semibold text-danger">
                {text.noteError}
              </p>
            ) : null}
          </div>
          <div>
            <Button
              ref={reviewButton}
              type="button"
              aria-disabled={pending ? true : undefined}
              onClick={review}
            >
              {text.review}
            </Button>
          </div>
        </>
      ) : (
        <div className="flex flex-col gap-3 rounded-md bg-gray-50 p-4">
          {/* What is sent: the decision, a split's amount as typed (cents on the server), the note. */}
          <input type="hidden" name="decision" value={decision ?? ""} />
          {decision === "partial" ? <input type="hidden" name="amount" value={amount} /> : null}
          <input type="hidden" name="note" value={note} />
          <h3
            ref={confirmHeading}
            tabIndex={-1}
            className="text-base font-bold outline-none focus-visible:ring-2 focus-visible:ring-green-700"
          >
            {text.confirmTitle}
          </h3>
          <p className="font-semibold">{sentence}</p>
          <p className="text-sm text-gray-500">{text.totals}</p>
          {decision && NEEDS_CODE.has(decision) ? (
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${id}-code`}>{text.codeLabel}</Label>
              <input
                id={`${id}-code`}
                type="text"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                value={typedCode}
                onChange={(event) => setTypedCode(event.target.value)}
                aria-describedby={`${id}-code-hint`}
                className={`${FIELD} max-w-48 font-mono`}
              />
              <p id={`${id}-code-hint`} className="text-sm text-gray-500">
                {text.codeHint}
              </p>
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              aria-disabled={blocked ? true : undefined}
              className={blocked ? "cursor-not-allowed opacity-60" : undefined}
            >
              {text.submit}
            </Button>
            <Button type="button" variant="secondary" onClick={back}>
              {text.back}
            </Button>
          </div>
        </div>
      )}
      <p role="status" className="text-sm text-gray-500 empty:hidden">
        {pending ? text.resolving : state.resolved ? text.resolved : ""}
      </p>
      {error ? (
        <p
          ref={errorBox}
          role="alert"
          tabIndex={-1}
          className="text-sm font-semibold text-danger outline-none"
        >
          {text.errors[error]}
        </p>
      ) : null}
    </form>
  );
}
