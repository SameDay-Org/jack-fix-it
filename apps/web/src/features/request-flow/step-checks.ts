import {
  CITY_MAX_LENGTH,
  emailInput,
  LINE_MAX_LENGTH,
  lineInput,
  nameInput,
  phoneInput,
  stateInput,
} from "./input";
import type { AddressDraft, ContactDraft } from "./types";

// The checks of the steps that load after the first ones (later-steps.ts): kept apart so the
// flow can tell which steps would go on (Back and Forward) without loading those steps.

export type AddressField = "line1" | "city" | "state";

/** The address fields that would be refused, in the form's order. */
export function addressErrors(address: AddressDraft): AddressField[] {
  const errors: AddressField[] = [];
  if (lineInput(address.line1, LINE_MAX_LENGTH) === null) errors.push("line1");
  if (lineInput(address.city, CITY_MAX_LENGTH) === null) errors.push("city");
  if (stateInput(address.state) === null) errors.push("state");
  return errors;
}

export type ContactField = "firstName" | "phone" | "email";

/** The contact fields that would be refused, in the form's order: all three are needed. */
export function contactErrors(contact: ContactDraft, countryCode: string): ContactField[] {
  const errors: ContactField[] = [];
  if (nameInput(contact.firstName) === null) errors.push("firstName");
  if (phoneInput(contact.phone, countryCode) === null) errors.push("phone");
  if (emailInput(contact.email) === null) errors.push("email");
  return errors;
}
