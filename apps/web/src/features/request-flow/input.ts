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
