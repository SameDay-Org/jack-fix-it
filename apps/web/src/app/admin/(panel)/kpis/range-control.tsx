"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState, useTransition, type FormEvent, type MouseEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import {
  KPIS_PATH,
  RANGE_PRESETS,
  rangeError,
  rangeHref,
  type RangeError,
  type RangePreset,
} from "./range";

export type RangeControlText = {
  label: string;
  presets: Record<RangePreset, string>;
  custom: string;
  from: string;
  to: string;
  apply: string;
  updating: string;
  errors: Record<RangeError, string>;
};

const PILL =
  "inline-flex h-9 items-center rounded-pill px-4 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-green-700 focus-visible:ring-offset-2";

/**
 * How long a range change runs before the control says it is updating. A quicker answer would
 * only flash the word for a frame or two (#453); the section is `aria-busy` from the start.
 */
export const UPDATING_DELAY_MS = 300;

/** True once `active` has stayed true for `delayMs`; false again as soon as it ends. */
function useShownAfter(active: boolean, delayMs: number): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => setShown(true), delayMs);
    return () => {
      clearTimeout(timer);
      setShown(false);
    };
  }, [active, delayMs]);
  return active && shown;
}

/**
 * The page's date range: presets as links (the range lives in the URL, so it can be shared),
 * then two days and a button. The days are checked here as the API checks them; the page is
 * rendered again on the server, and keeps showing the last figures until the new ones arrive.
 * Without JavaScript the links and the form still work (the form is a plain GET).
 */
export function RangeControl({
  preset,
  from,
  to,
  today,
  maxDays,
  text,
}: {
  preset: RangePreset | null;
  from: string;
  to: string;
  today: string;
  maxDays: number;
  text: RangeControlText;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const updating = useShownAfter(pending, UPDATING_DELAY_MS);
  const [error, setError] = useState<RangeError | null>(null);
  const errorId = useId();
  const customId = useId();

  const go = (href: string) => startTransition(() => router.push(href));

  const choose = (event: MouseEvent<HTMLAnchorElement>, days: RangePreset) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    setError(null);
    go(rangeHref({ kind: "preset", days }));
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const start = String(data.get("from") ?? "");
    const end = String(data.get("to") ?? "");
    const problem = rangeError(start, end, maxDays);
    setError(problem);
    if (problem === null) go(rangeHref({ kind: "custom", from: start, to: end }));
  };

  return (
    <section
      aria-label={text.label}
      aria-busy={pending}
      className="flex flex-col gap-4 rounded-lg bg-white p-4 shadow-[0_8px_24px_rgb(1_23_46/0.08)] md:p-5"
    >
      <div className="flex flex-wrap items-center gap-2">
        {RANGE_PRESETS.map((days) => (
          <Link
            key={days}
            href={rangeHref({ kind: "preset", days })}
            onClick={(event) => choose(event, days)}
            aria-current={days === preset ? "true" : undefined}
            className={cn(
              PILL,
              days === preset
                ? "bg-navy-900 text-white"
                : "bg-gray-50 text-navy-900 hover:bg-white hover:shadow-sm",
            )}
          >
            {text.presets[days]}
          </Link>
        ))}
        <span aria-live="polite" className="text-sm text-gray-500">
          {updating ? text.updating : ""}
        </span>
      </div>
      <form
        action={KPIS_PATH}
        method="get"
        noValidate
        onSubmit={submit}
        aria-labelledby={customId}
        className="flex flex-col gap-3 border-t border-navy-900/10 pt-4 sm:flex-row sm:flex-wrap sm:items-end"
      >
        <p id={customId} className="w-full text-sm font-semibold text-navy-900">
          {text.custom}
        </p>
        <div className="flex flex-col gap-1">
          <Label htmlFor="kpi-from">{text.from}</Label>
          <Input
            id="kpi-from"
            name="from"
            type="date"
            defaultValue={from}
            max={today}
            aria-invalid={error === null ? undefined : true}
            aria-describedby={error === null ? undefined : errorId}
            className="sm:w-44"
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="kpi-to">{text.to}</Label>
          <Input
            id="kpi-to"
            name="to"
            type="date"
            defaultValue={to}
            max={today}
            aria-invalid={error === null ? undefined : true}
            aria-describedby={error === null ? undefined : errorId}
            className="sm:w-44"
          />
        </div>
        <Button type="submit" variant="secondary" disabled={pending}>
          {text.apply}
        </Button>
        {error === null ? null : (
          <p id={errorId} role="alert" className="w-full text-sm font-semibold text-danger">
            {text.errors[error]}
          </p>
        )}
      </form>
    </section>
  );
}
