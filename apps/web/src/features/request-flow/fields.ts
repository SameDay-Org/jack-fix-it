// Class strings and helpers the request flow's client components share. Plain strings, no `cn`:
// a client component on a public page must not ship tailwind-merge (apps/web/AGENTS.md).

import { FOCUS_ON_LIGHT } from "@/features/site/ui";

export const LABEL = "block text-base font-bold text-navy-900";
export const HINT = "mt-1 text-sm text-gray-500";
export const ERROR = "mt-2 text-sm font-semibold text-danger";

/** A text field: a visible border on white, the brand's focus ring, red when invalid. */
export const INPUT = `mt-2 block w-full rounded-md border-2 border-gray-500 bg-white px-4 py-3 text-base text-navy-900 aria-invalid:border-danger ${FOCUS_ON_LIGHT}`;

/** One radio or checkbox with its words, the whole row clickable. */
export const CHOICE = `flex cursor-pointer items-start gap-3 rounded-lg border-2 border-gray-500/30 bg-white px-4 py-3 has-checked:border-navy-900 has-checked:bg-gray-50 has-focus-visible:ring-2 has-focus-visible:ring-green-700 has-focus-visible:ring-offset-2`;
export const CHOICE_INPUT = "mt-0.5 size-5 shrink-0 accent-navy-900 outline-none";

/** The step's main button, and the quieter one beside it. */
export const PRIMARY = `inline-flex h-12 items-center justify-center gap-2 rounded-pill bg-green-500 px-7 text-base font-bold text-navy-900 transition-colors hover:bg-green-700 hover:text-white aria-disabled:cursor-progress ${FOCUS_ON_LIGHT}`;
export const SECONDARY = `inline-flex h-12 items-center justify-center rounded-pill border-2 border-navy-900 px-7 text-base font-bold text-navy-900 transition-colors hover:bg-gray-50 ${FOCUS_ON_LIGHT}`;
export const TEXT_BUTTON = `rounded-sm font-bold text-navy-900 underline underline-offset-4 hover:text-green-700 ${FOCUS_ON_LIGHT}`;

/** `template` with each `{{name}}` replaced by its value (the catalogs' interpolation). */
export function fill(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) =>
    name in values ? String(values[name]) : match,
  );
}

/** The ids a field's hint and error get, for `aria-describedby`. */
export function describedBy(id: string, hint: boolean, error: boolean): string | undefined {
  const ids = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean);
  return ids.length > 0 ? ids.join(" ") : undefined;
}
