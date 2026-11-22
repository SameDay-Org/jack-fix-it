"use client";

import { type InputHTMLAttributes, type ReactNode, type RefObject, useEffect, useRef } from "react";

import { describedBy, ERROR, HINT, INPUT, LABEL } from "./fields";

// The pieces every step of the request flow is made of (#86).

export type Problem = { id: string | null; message: string };

export type Heading = RefObject<HTMLHeadingElement | null>;

type StepFrameProps = {
  heading: Heading;
  progress: string | null;
  title: string;
  support: string | null;
  /** A line about what just happened (an answer refused, a ZIP now served), above the form. */
  notice?: string | null;
  children: ReactNode;
};

/** A step's top: where it is in the flow, its heading (focused on arrival) and one line. */
export function StepFrame({ heading, progress, title, support, notice, children }: StepFrameProps) {
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
      {notice ? (
        <p role="status" className="rounded-lg bg-gray-50 px-4 py-3 font-semibold text-navy-900">
          {notice}
        </p>
      ) : null}
      {children}
    </section>
  );
}

/**
 * What stops the step, at its top: focused each time it is refused, its lines links to the
 * fields (or plain text for what no field can fix, like a service that is down).
 */
export function ProblemBox({
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

export function Actions({ children }: { children: ReactNode }) {
  return <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center">{children}</div>;
}

type TextFieldProps = {
  id: string;
  label: string;
  hint?: string;
  error: string | null;
  value: string;
  onChange: (value: string) => void;
  className?: string;
} & Pick<
  InputHTMLAttributes<HTMLInputElement>,
  "type" | "inputMode" | "autoComplete" | "maxLength" | "min" | "autoCapitalize"
>;

/** One labelled text field with its hint and its error, as every step lays them out. */
export function TextField({
  id,
  label,
  hint,
  error,
  value,
  onChange,
  className = "",
  type = "text",
  ...input
}: TextFieldProps) {
  return (
    <div>
      <label htmlFor={id} className={LABEL}>
        {label}
      </label>
      {hint ? (
        <p id={`${id}-hint`} className={HINT}>
          {hint}
        </p>
      ) : null}
      <input
        id={id}
        name={id}
        type={type}
        value={value}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint !== undefined, error !== null)}
        className={`${INPUT} ${className}`}
        onChange={(event) => onChange(event.target.value)}
        {...input}
      />
      {error ? (
        <p id={`${id}-error`} className={ERROR}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
