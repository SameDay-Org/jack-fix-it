import { ApiError, NetworkError } from "@/api";

import type { SavedAddress } from "./api";

type Book = readonly SavedAddress[];

/*
 * The book as the API lists it (`SavedAddressList`): the default first, then the oldest first. The
 * edits below keep that order on the device as far as it can tell, so an optimistic change shows
 * what the next GET most likely will. What it cannot tell is where a default that stops being one
 * falls among the others: addresses carry no creation date (see `nextDefaultAfter`).
 */

/** `address` as the default, first; every other address after it, in its order, not the default. */
export function withDefault(book: Book, id: string): SavedAddress[] {
  const target = book.find((address) => address.id === id);
  if (!target) return [...book];
  const rest = book
    .filter((address) => address.id !== id)
    .map((address) => (address.is_default ? { ...address, is_default: false } : address));
  return [{ ...target, is_default: true }, ...rest];
}

/**
 * The book without `id`. When that was the default, the API makes the oldest remaining address the
 * default: the first one left, since the others are listed oldest first.
 */
export function withoutAddress(book: Book, id: string): SavedAddress[] {
  const removed = book.find((address) => address.id === id);
  const rest = book.filter((address) => address.id !== id);
  if (!removed?.is_default || rest.length === 0) return rest;
  return withDefault(rest, rest[0].id);
}

/** A change to the book: the book with it. The writes in flight are replayed as these. */
export type BookEdit = (book: Book) => SavedAddress[];

/**
 * The address that becomes the default once the default `id` is deleted, when the device can tell.
 * The API promotes the oldest remaining one: the only other address, or the first of the others
 * in a book as the server `listed` it (they come oldest first). In a book this device redrew
 * since, their order is a guess, as addresses carry no creation date: undefined.
 */
export function nextDefaultAfter(
  book: Book,
  id: string,
  listed: boolean,
): SavedAddress | undefined {
  const others = book.filter((address) => address.id !== id);
  return listed || others.length === 1 ? others[0] : undefined;
}

/** The book with the server's copy of a new address: first when it is the default, else last. */
export function withAdded(book: Book, address: SavedAddress): SavedAddress[] {
  const rest = book.filter((saved) => saved.id !== address.id);
  return address.is_default ? withDefault([address, ...rest], address.id) : [...rest, address];
}

/** The book with the server's copy of an edited address, in its place. */
export function withUpdated(book: Book, address: SavedAddress): SavedAddress[] {
  const updated = book.map((saved) => (saved.id === address.id ? address : saved));
  return address.is_default ? withDefault(updated, address.id) : updated;
}

/**
 * A label as the API compares two (`address_label_taken`): composed, its runs of spaces one,
 * ignoring case. The server stays the judge; this only spares a round trip for the obvious case.
 */
export const labelKey = (label: string): string =>
  label.normalize("NFC").split(/\s+/).filter(Boolean).join(" ").toLowerCase();

/** Whether another address of the book (not `exceptId`) already has this label. */
export const isLabelTaken = (book: Book, label: string, exceptId?: string): boolean =>
  book.some((address) => address.id !== exceptId && labelKey(address.label) === labelKey(label));

/** Why a write to the book failed, as the screens word it (`addresses.failed.*`). */
export type AddressFailure =
  "offline" | "rateLimited" | "full" | "labelTaken" | "labelInvalid" | "gone" | "generic";

const BY_CODE: Readonly<Record<string, AddressFailure>> = {
  rate_limited: "rateLimited",
  address_limit_reached: "full",
  address_label_taken: "labelTaken",
  address_not_found: "gone",
  // The form checks the street, city, state and ZIP before sending; what the server refuses past
  // those checks is the label (a contact detail, a street or a unit in it, an invisible character).
  validation_error: "labelInvalid",
};

export function addressFailure(error: unknown): AddressFailure {
  if (error instanceof NetworkError) return "offline";
  if (error instanceof ApiError && error.code !== undefined && Object.hasOwn(BY_CODE, error.code)) {
    return BY_CODE[error.code];
  }
  return "generic";
}
