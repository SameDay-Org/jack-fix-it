import { ApiError, NetworkError, type PatchBody } from "@/api";

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

/** A book of one address: it is the default (the API keeps one while the book is not empty). */
const withSoleDefault = (book: Book): Book =>
  book.items.length === 1 && !book.items[0].is_default
    ? { items: [{ ...book.items[0], is_default: true }], ordered: true }
    : book;

/**
 * `id` as the default, first. The old default joins the others in front, which is a guess: the
 * book is `ordered` only when it is then the only other address.
 */
export function withDefault(book: Book, id: string): Book {
  const target = book.items.find((address) => address.id === id);
  if (!target || target.is_default) return book;
  const rest = book.items
    .filter((address) => address.id !== id)
    .map((address) => (address.is_default ? { ...address, is_default: false } : address));
  return { items: [{ ...target, is_default: true }, ...rest], ordered: rest.length <= 1 };
}

/**
 * The book without `id`. When that was the default, the API makes the oldest remaining address the
 * default: the first of the others in an `ordered` book. In one that is not, the device cannot
 * tell which, and draws no default until the server lists the book.
 */
export function withoutAddress(book: Book, id: string): Book {
  const removed = book.items.find((address) => address.id === id);
  if (!removed) return book;
  const rest = book.items.filter((address) => address.id !== id);
  if (removed.is_default && book.ordered && rest.length > 0) {
    return { items: [{ ...rest[0], is_default: true }, ...rest.slice(1)], ordered: true };
  }
  return withSoleDefault({
    items: rest,
    ordered: others(rest).length <= 1 || (!removed.is_default && book.ordered),
  });
}

/**
 * The book with the server's copy of a new address: the newest, so the last of the others, or
 * the default when the server made it one (the first address of a book). A book that already has
 * it stays as it is: its list was read after the server added the address, so its copy is the
 * newer one.
 */
export function withAdded(book: Book, address: SavedAddress): Book {
  if (book.items.some((saved) => saved.id === address.id)) return book;
  const added = { ...book, items: [...book.items, { ...address, is_default: false }] };
  return address.is_default ? withDefault(added, address.id) : withSoleDefault(added);
}

type AddressPatch = PatchBody<"/v1/addresses/{address_id}">;

/**
 * What each field of a PATCH sets on the server's copy of the address: itself, and what the API
 * reads from it (`served` follows the ZIP; the coordinates are stored together). Who is the
 * default is not one address's field: `withDefault` draws it.
 */
const SET_BY: {
  readonly [Field in keyof Required<AddressPatch>]: (saved: SavedAddress) => Partial<SavedAddress>;
} = {
  label: ({ label }) => ({ label }),
  line1: ({ line1 }) => ({ line1 }),
  line2: ({ line2 }) => ({ line2 }),
  city: ({ city }) => ({ city }),
  state: ({ state }) => ({ state }),
  zip_code: ({ zip_code, served }) => ({ zip_code, served }),
  lat: ({ lat, lng }) => ({ lat, lng }),
  lng: ({ lat, lng }) => ({ lat, lng }),
  is_default: () => ({}),
};
const PATCH_FIELDS = Object.keys(SET_BY) as (keyof AddressPatch)[];

/** The fields a PATCH clears when it sends null; null for any other leaves the field as it is. */
const CLEARED_BY_NULL: ReadonlySet<keyof AddressPatch> = new Set(["line2", "lat", "lng"]);

const sends = (sent: AddressPatch, field: keyof AddressPatch): boolean =>
  sent[field] !== undefined && (sent[field] !== null || CLEARED_BY_NULL.has(field));

/**
 * The book with what an edit changed: of the server's answer `saved`, only the fields its request
 * `sent`, on the address in its place. The answer is a copy of the whole address as it was when
 * the server answered, and the server takes two writes in flight in either order: its other
 * fields may be older than what another write (a second edit, a default change) changed and
 * already answered, so replaying them would draw over that answer. Who is the default stays as
 * drawn for the same reason.
 */
export function withFields(book: Book, saved: SavedAddress, sent: AddressPatch): Book {
  const changed = PATCH_FIELDS.filter((field) => sends(sent, field)).reduce<Partial<SavedAddress>>(
    (fields, field) => ({ ...fields, ...SET_BY[field](saved) }),
    {},
  );
  return {
    ...book,
    items: book.items.map((address) =>
      address.id === saved.id ? { ...address, ...changed } : address,
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
