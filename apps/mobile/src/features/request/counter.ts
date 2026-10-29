import type { TFunction } from "i18next";

import i18n from "@/i18n";

// The counter shows once a text is this close to its limit (90% of it), not before: a number
// ticking from the first letter would only distract.
const COUNTER_FROM = 0.9;

/** "1,850 / 2,000" once `length` nears `max`, else nothing. */
export function lengthCounter(t: TFunction, length: number, max: number): string | undefined {
  if (length < Math.floor(max * COUNTER_FROM)) return undefined;
  const format = new Intl.NumberFormat(i18n.resolvedLanguage).format;
  return t("request.counter", { length: format(length), max: format(max) });
}
