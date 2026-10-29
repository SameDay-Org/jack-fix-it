import type { PostBody } from "@/api";
import type { SavedAddress } from "@/features/addresses";

import type { AddressChoice, AddressFields } from "./requestDraft";

type AddressIn = PostBody<"/v1/requests">["address"];

/** Why a typed field cannot go yet. */
export type AddressError = "required" | "state" | "zip";

// What the API takes (AddressIn): a two-letter state and a 5-digit ZIP (ZIP+4 is not offered).
const STATE = /^[A-Za-z]{2}$/;
const ZIP = /^[0-9]{5}$/;

/** Every typed field that cannot go yet. Line 2 is optional. */
export function addressErrors(
  fields: AddressFields,
): Partial<Record<keyof AddressFields, AddressError>> {
  const errors: Partial<Record<keyof AddressFields, AddressError>> = {};
  if (!fields.line1.trim()) errors.line1 = "required";
  if (!fields.city.trim()) errors.city = "required";
  const state = fields.state.trim();
  if (!state) errors.state = "required";
  else if (!STATE.test(state)) errors.state = "state";
  const zip = fields.zipCode.trim();
  if (!zip) errors.zipCode = "required";
  else if (!ZIP.test(zip)) errors.zipCode = "zip";
  return errors;
}

/** The typed address as `RequestCreate.address`: trimmed, the state in capitals. */
export function typedAddressBody(fields: AddressFields): AddressIn {
  const line2 = fields.line2.trim();
  return {
    line1: fields.line1.trim(),
    ...(line2 ? { line2 } : {}),
    city: fields.city.trim(),
    state: fields.state.trim().toUpperCase(),
    zip_code: fields.zipCode.trim(),
  };
}

export function savedAddressBody(address: SavedAddress): AddressIn {
  return {
    line1: address.line1,
    ...(address.line2 ? { line2: address.line2 } : {}),
    city: address.city,
    state: address.state,
    zip_code: address.zip_code,
  };
}

/** The address the request goes to, once the saved ones are known. */
export type ResolvedAddress = { kind: "saved"; address: SavedAddress } | { kind: "typed" };

/**
 * What the Where step shows as chosen. The customer's pick while it is still a served saved address;
 * before any pick, the default (or else the first) served saved address; otherwise the form. An
 * address outside the service areas is never chosen for them: the API would refuse it.
 */
export function resolveAddress(
  choice: AddressChoice,
  saved: readonly SavedAddress[] | undefined,
): ResolvedAddress {
  const served = (saved ?? []).filter((address) => address.served);
  if (choice?.kind === "typed") return choice;
  const picked = choice ? served.find((address) => address.id === choice.id) : undefined;
  const fallback = served.find((address) => address.is_default) ?? served[0];
  const address = picked ?? (choice ? undefined : fallback);
  return address ? { kind: "saved", address } : { kind: "typed" };
}

/** One line for a saved address: "120 Main St, Apt 4, Miami, FL 33101". */
export function addressLine(address: AddressIn | SavedAddress): string {
  const street = [address.line1, address.line2].filter(Boolean).join(", ");
  return `${street}, ${address.city}, ${address.state} ${address.zip_code}`;
}
