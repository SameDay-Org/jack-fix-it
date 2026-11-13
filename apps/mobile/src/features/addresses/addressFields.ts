import type { PostBody } from "@/api";

/** A US address as typed into the app's address form (the request flow's, the sign-up's). */
export type AddressFields = {
  line1: string;
  line2: string;
  city: string;
  state: string;
  zipCode: string;
};

export const EMPTY_ADDRESS_FIELDS: AddressFields = {
  line1: "",
  line2: "",
  city: "",
  state: "",
  zipCode: "",
};

/** Why a typed field cannot go yet. */
export type AddressError = "required" | "tooLong" | "state" | "zip";

export type AddressErrors = Partial<Record<keyof AddressFields, AddressError>>;

/**
 * The most characters the API takes (AddressIn's maxLength, after it trims) for the street, the
 * unit and the city. Counted here in UTF-16 units, as the inputs' `maxLength` counts them: never
 * fewer than the API's code points, so nothing accepted here is too long for it.
 */
export const ADDRESS_MAX = { line1: 255, line2: 255, city: 128 } as const;

/** The most characters a saved address's name takes (`SavedAddressIn.label`), counted the same way. */
export const LABEL_MAX = 30;

// What the API takes (AddressIn): a two-letter state and a 5-digit ZIP (ZIP+4 is not offered).
const STATE = /^[A-Za-z]{2}$/;
const ZIP = /^[0-9]{5}$/;

/**
 * The 50 states and the District of Columbia, as USPS writes them: what `home_state` accepts
 * (`users/locations.py`, and the database check behind it). A request's address only asks for two
 * letters, so the request flow does not check against this list.
 */
export const US_STATE_CODES: ReadonlySet<string> = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID", "IL",
  "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE",
  "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD",
  "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
]); // prettier-ignore

export const isUsStateCode = (state: string): boolean =>
  US_STATE_CODES.has(state.trim().toUpperCase());

/** Every typed field that cannot go yet. Line 2 is optional. */
export function addressErrors(fields: AddressFields): AddressErrors {
  const errors: AddressErrors = {};
  const line1 = fields.line1.trim();
  if (!line1) errors.line1 = "required";
  else if (line1.length > ADDRESS_MAX.line1) errors.line1 = "tooLong";
  if (fields.line2.trim().length > ADDRESS_MAX.line2) errors.line2 = "tooLong";
  const city = fields.city.trim();
  if (!city) errors.city = "required";
  else if (city.length > ADDRESS_MAX.city) errors.city = "tooLong";
  const state = fields.state.trim();
  if (!state) errors.state = "required";
  else if (!STATE.test(state)) errors.state = "state";
  const zip = fields.zipCode.trim();
  if (!zip) errors.zipCode = "required";
  else if (!ZIP.test(zip)) errors.zipCode = "zip";
  return errors;
}

/**
 * The typed address as the address book takes it (`SavedAddressIn`): trimmed, the state in
 * capitals, a blank unit left out, under `label`, and the default when `isDefault`.
 */
export function savedAddressInput(
  fields: AddressFields,
  label: string,
  isDefault: boolean,
): PostBody<"/v1/addresses"> {
  const line2 = fields.line2.trim();
  return {
    line1: fields.line1.trim(),
    ...(line2 ? { line2 } : {}),
    city: fields.city.trim(),
    state: fields.state.trim().toUpperCase(),
    zip_code: fields.zipCode.trim(),
    label,
    is_default: isDefault,
  };
}

/** What a one-line address needs: a saved address, or the copy a request keeps. */
type AddressParts = {
  line1: string;
  line2?: string | null;
  city: string;
  state: string;
  zip_code: string;
};

/** One line for an address: "120 Main St, Apt 4, Miami, FL 33101". */
export function addressLine(address: AddressParts): string {
  const street = [address.line1, address.line2].filter(Boolean).join(", ");
  return `${street}, ${address.city}, ${address.state} ${address.zip_code}`;
}
