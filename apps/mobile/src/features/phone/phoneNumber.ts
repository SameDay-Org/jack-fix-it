/**
 * US phone numbers (the North American Numbering Plan, calling code +1): national digits, the
 * `(555) 123-4567` display, and E.164 for the API. Only the US is in scope (#138); another country
 * needs its own rules, not a parameter here.
 */

/** Area code (3) plus subscriber number (7). */
export const NATIONAL_LENGTH = 10;

// NANP: the area code and the exchange start with 2-9.
const VALID_NATIONAL = /^[2-9][0-9]{2}[2-9][0-9]{6}$/;

const digitsOf = (text: string): string => text.replace(/[^0-9]/g, "");

/**
 * The national digits in what was typed, pasted or autofilled: separators dropped, the calling
 * code removed when the text carries it (`+1 555…`, or 11 digits starting with it), at most
 * `NATIONAL_LENGTH` digits.
 */
export function nationalDigits(text: string, countryCode: string): string {
  const codeDigits = digitsOf(countryCode);
  let digits = digitsOf(text);
  const withCode = text.trim().startsWith("+") || digits.length > NATIONAL_LENGTH;
  if (withCode && digits.startsWith(codeDigits)) digits = digits.slice(codeDigits.length);
  return digits.slice(0, NATIONAL_LENGTH);
}

/** `(555) 123-4567`, built up as the digits arrive: `(555`, `(555) 123`, `(555) 123-4`. */
export function formatNational(digits: string): string {
  if (digits.length === 0) return "";
  const area = digits.slice(0, 3);
  const exchange = digits.slice(3, 6);
  const line = digits.slice(6, NATIONAL_LENGTH);
  if (digits.length <= 3) return `(${area}`;
  if (digits.length <= 6) return `(${area}) ${exchange}`;
  return `(${area}) ${exchange}-${line}`;
}

/**
 * The digits after an edit of the formatted field. Deleting only a separator (a parenthesis, the
 * space or the dash: one character fewer, the same digits) would re-format to the same text and
 * trap the cursor, so it deletes the digit before that separator instead. Any other edit, an
 * autofill or a paste included, is taken as it is.
 */
export function editNationalDigits(previous: string, next: string, countryCode: string): string {
  const before = digitsOf(previous);
  const after = nationalDigits(next, countryCode);
  const deletedSeparator = next.length === previous.length - 1 && after === before;
  if (!deletedSeparator) return after;
  let at = 0; // where the one deleted character was
  while (at < next.length && previous[at] === next[at]) at += 1;
  const digitsBefore = digitsOf(previous.slice(0, at)).length;
  if (digitsBefore === 0) return after;
  return after.slice(0, digitsBefore - 1) + after.slice(digitsBefore);
}

/** A complete, well-formed US number: 10 digits, area code and exchange starting with 2-9. */
export const isValidNational = (digits: string): boolean => VALID_NATIONAL.test(digits);

/** `+15551234567`: what the API takes. */
export const toE164 = (countryCode: string, digits: string): string => `${countryCode}${digits}`;

/** `+1 (555) 123-4567` for an E.164 number with this calling code; anything else as given. */
export function formatE164(phone: string, countryCode: string): string {
  const national = phone.startsWith(countryCode) ? phone.slice(countryCode.length) : "";
  return national.length === NATIONAL_LENGTH && /^[0-9]+$/.test(national)
    ? `${countryCode} ${formatNational(national)}`
    : phone;
}
