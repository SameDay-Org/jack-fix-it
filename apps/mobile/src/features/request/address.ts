import type { PostBody } from "@/api";
import type { SavedAddress } from "@/features/addresses";

import type { AddressChoice, AddressFields } from "./requestDraft";

type AddressIn = PostBody<"/v1/requests">["address"];

// The typed fields' rules are the shared address form's (the sign-up's Home step uses them too).
export { ADDRESS_MAX, addressErrors } from "@/features/addresses/addressFields";
export type { AddressError } from "@/features/addresses/addressFields";

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
