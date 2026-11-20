"use client";

import { type FormEvent, useEffect, useRef, useState, useTransition } from "react";

import { FOCUS_ON_LIGHT, PRIMARY_ACTION } from "@/features/site/ui";
import type { Locale } from "@/i18n/config";
import { EMAIL_MAX_LENGTH, emailInput } from "@/lib/public-form/email";

import type { InterestError, InterestInput, InterestResult, InterestText } from "./types";

// Plain class strings: a client component on a public page does not import `cn` (it would ship
// tailwind-merge; apps/web/AGENTS.md).
const INPUT = `block h-12 w-full rounded-md border-2 border-gray-500 bg-white px-4 text-base text-navy-900 aria-invalid:border-danger ${FOCUS_ON_LIGHT}`;
const LINK = `rounded-sm font-bold text-navy-900 underline underline-offset-4 hover:text-green-700 ${FOCUS_ON_LIGHT}`;

type InterestFormProps = {
  locale: Locale;
  text: InterestText;
  privacyHref: string;
  /** The form's token, asked once the visitor reaches the form (interestToken). */
  getToken: () => Promise<string | null>;
  join: (input: InterestInput) => Promise<InterestResult>;
};

/**
 * "Tell me when the app is out" (#409): one email, the consent line, Notify me. The token is
 * asked when the visitor first reaches the form, not with the page (built ahead). A refusal keeps
 * the email and says what to do; the button sends once while it waits; on the list, the form
 * gives way to one line, which takes the focus. The hidden field is a trap for scripts.
 */
export function InterestForm({ locale, text, privacyHref, getToken, join }: InterestFormProps) {
  const [email, setEmail] = useState("");
  const [website, setWebsite] = useState("");
  const [error, setError] = useState<InterestError | null>(null);
  const [waitMinutes, setWaitMinutes] = useState<number | null>(null);
  const [joined, setJoined] = useState(false);
  const [pending, startTransition] = useTransition();
  const token = useRef<Promise<string | null> | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const done = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (joined) done.current?.focus();
  }, [joined]);

  /** The token, asked once; a failed ask is asked again next time. */
  function ensureToken(): Promise<string | null> {
    token.current ??= getToken().catch(() => {
      token.current = null;
      return null;
    });
    return token.current;
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    if (emailInput(email) === null) {
      setError("invalid_email");
      input.current?.focus();
      return;
    }
    setError(null);
    startTransition(async () => {
      let result: InterestResult;
      try {
        const current = await ensureToken();
        result = current
          ? await join({ token: current, website, email, locale })
          : { kind: "error", error: "unavailable" };
      } catch {
        result = { kind: "error", error: "unavailable" };
      }
      if (result.kind === "joined") return setJoined(true);
      if (result.token) token.current = Promise.resolve(result.token);
      setError(result.error);
      setWaitMinutes(result.waitMinutes ?? null);
      if (result.error === "invalid_email") input.current?.focus();
    });
  }

  if (joined) {
    return (
      <p
        ref={done}
        tabIndex={-1}
        role="status"
        className="mt-8 w-full max-w-xl rounded-lg bg-white px-6 py-5 text-lg font-semibold text-navy-900 shadow-xl shadow-navy-900/10 outline-none"
      >
        {text.joined}
      </p>
    );
  }

  const fieldError = error === "invalid_email";
  return (
    <form
      noValidate
      onSubmit={submit}
      aria-labelledby="interest-title"
      className="mt-8 flex w-full max-w-xl flex-col gap-3 rounded-lg bg-white p-6 text-left shadow-xl shadow-navy-900/10"
    >
      <h3 id="interest-title" className="text-xl font-extrabold text-navy-900">
        {text.title}
      </h3>
      <p id="interest-hint" className="text-base text-gray-500">
        {text.hint}
      </p>
      <label htmlFor="interest-email" className="mt-2 text-base font-bold text-navy-900">
        {text.label}
      </label>
      <div className="flex flex-col gap-3 sm:flex-row">
        <input
          ref={input}
          id="interest-email"
          name="email"
          type="email"
          autoComplete="email"
          maxLength={EMAIL_MAX_LENGTH}
          value={email}
          aria-invalid={fieldError || undefined}
          aria-describedby={fieldError ? "interest-hint interest-error" : "interest-hint"}
          className={INPUT}
          onFocus={() => void ensureToken()}
          onChange={(event) => setEmail(event.target.value)}
        />
        <button
          type="submit"
          aria-disabled={pending || undefined}
          className={`${PRIMARY_ACTION} ${FOCUS_ON_LIGHT} shrink-0`}
        >
          {text.submit}
        </button>
      </div>
      {error ? (
        <p
          id="interest-error"
          role={fieldError ? undefined : "alert"}
          className="text-sm font-semibold text-danger"
        >
          {error === "rate_limited" && waitMinutes !== null
            ? text.rateLimitedIn.replace("{{minutes}}", String(waitMinutes))
            : text.errors[error]}
        </p>
      ) : null}
      <p role="status" className="text-sm text-gray-500">
        {pending ? text.sending : ""}
      </p>
      {/* Only a script fills this: off screen, out of the tab order, hidden from readers. */}
      <div aria-hidden="true" className="absolute -left-[9999px] h-px w-px overflow-hidden">
        <label htmlFor="interest-website">{text.honeypot}</label>
        <input
          id="interest-website"
          name="website"
          type="text"
          tabIndex={-1}
          autoComplete="off"
          value={website}
          onChange={(event) => setWebsite(event.target.value)}
        />
      </div>
      <p className="text-sm text-gray-500">
        {text.consent}{" "}
        <a href={privacyHref} className={LINK}>
          {text.privacy}
        </a>
      </p>
    </form>
  );
}
