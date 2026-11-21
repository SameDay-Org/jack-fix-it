/**
 * What the web request flow (#86) accepts as typed, checked the same way in the browser and in
 * its server actions (a server action is a public endpoint). The API stays the authority: these
 * rules only catch a mistake before a round trip, and mirror the API's own patterns.
 */

/** 5 digits, or ZIP+4: the API's ZIP_INPUT_PATTERN (service_areas/schemas.py). */
const ZIP = /^[0-9]{5}(-[0-9]{4})?$/;

/** The ZIP as typed, trimmed, when it is one the API takes; else null. */
export function zipInput(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const zip = text.trim();
  return ZIP.test(zip) ? zip : null;
}

/** The longest address the API stores (users.email, waitlist.email). */
export const EMAIL_MAX_LENGTH = 320;

// One @, something on each side, a dot in the domain, no spaces: the API's EmailStr is stricter.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The address trimmed and lowercased (the API's NormalizedEmail), or null when it is not one. */
export function emailInput(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const email = text.trim().toLowerCase();
  return email.length <= EMAIL_MAX_LENGTH && EMAIL.test(email) ? email : null;
}

/** Area code (3) plus subscriber number (7): US numbers only (#138), as in the app. */
const NATIONAL_LENGTH = 10;

// NANP: the area code and the exchange start with 2-9 (apps/mobile phone/phoneNumber.ts).
const VALID_NATIONAL = /^[2-9][0-9]{2}[2-9][0-9]{6}$/;

/**
 * The number in E.164 (`+15551234567`, what the API takes) from what was typed, pasted or
 * autofilled: `(555) 123-4567`, `555.123.4567`, `+1 555 123 4567`. Null when it is not a complete
 * US number.
 */
export function phoneInput(text: unknown, countryCode: string): string | null {
  if (typeof text !== "string" || text.length > 40) return null;
  const codeDigits = countryCode.replace(/[^0-9]/g, "");
  let digits = text.replace(/[^0-9]/g, "");
  const withCode = text.trim().startsWith("+") || digits.length > NATIONAL_LENGTH;
  if (withCode) {
    if (!digits.startsWith(codeDigits)) return null;
    digits = digits.slice(codeDigits.length);
  }
  return VALID_NATIONAL.test(digits) ? `${countryCode}${digits}` : null;
}

/** The description's limits: the API's RequestCreate.description (trimmed, 1 to 2000). */
export const DESCRIPTION_MAX_LENGTH = 2000;

/** Whether the description can go: something besides spaces, within the limit. */
export function descriptionFits(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && trimmed.length <= DESCRIPTION_MAX_LENGTH;
}

/** The longest first or last name the API stores (users.names NAME_MAX_LENGTH). */
export const NAME_MAX_LENGTH = 60;

// Letters (with their accents), spaces, hyphens, apostrophes and periods: the API's PersonName.
const NAME = /^[\p{L}\p{M} '\u2019.-]+$/u;
const LETTER = /\p{L}/u;

/** The name with its spaces collapsed, or null when the API would refuse it. */
export function nameInput(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const name = text.split(/\s+/).filter(Boolean).join(" ");
  return name.length <= NAME_MAX_LENGTH && NAME.test(name) && LETTER.test(name) ? name : null;
}

/** The API's address limits (addresses/schemas.py). */
export const LINE_MAX_LENGTH = 255;
export const CITY_MAX_LENGTH = 128;

// Control characters never belong in an address; the API refuses NUL.
const CONTROL = /[\u0000-\u001f\u007f]/;

/** An address line or a city, trimmed, when it has something and fits; else null. */
export function lineInput(text: unknown, max: number): string | null {
  if (typeof text !== "string") return null;
  const line = text.trim();
  return line.length > 0 && line.length <= max && !CONTROL.test(line) ? line : null;
}

/** A state as the API takes it: two letters, upper case (`fl` becomes `FL`). */
export function stateInput(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const state = text.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(state) ? state : null;
}

// Days as the API takes them: YYYY-MM-DD. It refuses one before today in UTC, and a day already
// over on the visitor's calendar makes no sense either (apps/mobile request/dates.ts).
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Today as the API counts it (UTC). */
export function utcToday(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Today on the visitor's own calendar. */
export function localToday(now: Date): string {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

/** The first day the visitor can pick: the later of the two todays. ISO days compare as text. */
export function firstDay(now: Date): string {
  const utc = utcToday(now);
  const local = localToday(now);
  return local > utc ? local : utc;
}

/** The day when it is a real one, `from` or later; else null. */
export function dayInput(text: unknown, from: string): string | null {
  if (typeof text !== "string" || !DAY.test(text)) return null;
  const date = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) return null;
  return text >= from ? text : null;
}
