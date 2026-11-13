import { ApiError, NetworkError } from "@/api";

import type { SavedAddress } from "./api";

type Addresses = readonly SavedAddress[];

/**
 * The book as the device draws it: its addresses, the default first, and whether the device can
 * vouch for the order of the others. The API lists them oldest first, and promotes the first of
 * them when the default is deleted. A list from the server is `ordered`. The device loses track
 * when a default stops being one: nothing tells where it falls among the others, since addresses
 * carry no creation date.
 */
export type Book = { readonly items: Addresses; readonly ordered: boolean };

/** A change to the book: the book with it. The writes in flight are replayed as these. */
export type BookEdit = (book: Book) => Book;

const others = (items: Addresses) => items.filter((address) => !address.is_default);

/**
 * `id` as the default, first. The old default joins the others in front, which is a guess: the
 * book stays `ordered` only when it is then the only other address.
 */
export function withDefault(book: Book, id: string): Book {
  const target = book.items.find((address) => address.id === id);
  if (!target || target.is_default) return book;
  const hadDefault = book.items.some((address) => address.is_default);
  const rest = book.items
    .filter((address) => address.id !== id)
    .map((address) => (address.is_default ? { ...address, is_default: false } : address));
  return {
    items: [{ ...target, is_default: true }, ...rest],
    ordered: rest.length <= 1 || (book.ordered && !hadDefault),
  };
}

/**
 * The book without `id`. When that was the default, the API makes the oldest remaining address the
 * default: the first of the others in an `ordered` book. In one that is not, the device cannot
 * tell which, and draws no default until the server lists the book. The only address left is the
 * default either way.
 */
export function withoutAddress(book: Book, id: string): Book {
  const removed = book.items.find((address) => address.id === id);
  if (!removed) return book;
  const rest = book.items.filter((address) => address.id !== id);
  const promoted = rest.length === 1 || (removed.is_default && book.ordered);
  if (!promoted || rest.length === 0) {
    return {
      items: rest,
      ordered: others(rest).length <= 1 || (!removed.is_default && book.ordered),
    };
  }
  return { items: [{ ...rest[0], is_default: true }, ...rest.slice(1)], ordered: true };
}

/**
 * The book with the server's copy of a new address: the newest, so the last of the others, or
 * the default when the server made it one (the first address of a book).
 */
export function withAdded(book: Book, address: SavedAddress): Book {
  if (book.items.some((saved) => saved.id === address.id)) return withFields(book, address);
  const added = { ...book, items: [...book.items, { ...address, is_default: false }] };
  return address.is_default ? withDefault(added, address.id) : added;
}

/**
 * The book with the server's copy of an address's fields, in its place. Who is the default stays
 * as drawn: an edit never moves it, and its answer may be older than a change drawn since.
 */
export function withFields(book: Book, address: SavedAddress): Book {
  return {
    ...book,
    items: book.items.map((saved) =>
      saved.id === address.id ? { ...address, is_default: saved.is_default } : saved,
    ),
  };
}

/**
 * A label as the API compares two (`address_label_taken`): composed, its runs of spaces one,
 * ignoring case. The server stays the judge; this only spares a round trip for the obvious case.
 */
export const labelKey = (label: string): string =>
  label.normalize("NFC").split(/\s+/).filter(Boolean).join(" ").toLowerCase();

/** Whether another address of the book (not `exceptId`) already has this label. */
export const isLabelTaken = (book: Addresses, label: string, exceptId?: string): boolean =>
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
