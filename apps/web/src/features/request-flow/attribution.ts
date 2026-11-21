import type { Utm } from "./types";

// Where a request came from (#86 spec §6): the five `utm_*` keys of the address the visitor
// came in by (the API's UtmIn takes those only). Read from /request's own address by the server,
// carried in the page's state, checked again when sent. No cookie, nothing stored for a visitor
// who does not send.

const UTM_KEYS = ["source", "medium", "campaign", "term", "content"] as const;

/** The API's UtmIn: up to 100 characters each. */
const UTM_MAX_LENGTH = 100;
const CONTROL = /[\u0000-\u001f\u007f]/;

function one(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length > 0 && text.length <= UTM_MAX_LENGTH && !CONTROL.test(text) ? text : null;
}

/** The known keys that are set and fit; any other key is dropped. Null when none is. */
export function utmInput(
  values: Partial<Record<keyof Utm, unknown>> | null | undefined,
): Utm | null {
  if (!values) return null;
  const utm: Utm = {};
  for (const key of UTM_KEYS) {
    const value = one(values[key]);
    if (value !== null) utm[key] = value;
  }
  return Object.keys(utm).length > 0 ? utm : null;
}

/** The `utm_*` keys of a page's query. */
export function utmFromSearch(search: Record<string, string | string[] | undefined>): Utm | null {
  return utmInput(Object.fromEntries(UTM_KEYS.map((key) => [key, search[`utm_${key}`]])));
}
