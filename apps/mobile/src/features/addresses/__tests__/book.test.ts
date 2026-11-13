import { ApiError, NetworkError } from "@/api";

import { savedAddress } from "../../request/__tests__/helpers";
import {
  addressFailure,
  isLabelTaken,
  withAdded,
  withDefault,
  withFields,
  withoutAddress,
  type Book,
} from "../book";

jest.mock("@/api", () => jest.requireActual("../../../api/errors"));

// As the API lists them: the default first, then the oldest first.
const HOME = savedAddress({ id: "home", label: "Home", is_default: true });
const WORK = savedAddress({ id: "work", label: "Work", is_default: false });
const MOM = savedAddress({ id: "mom", label: "Mom's place", is_default: false });
const BOOK = [HOME, WORK, MOM];

/** A book as the server lists it: the device can vouch for its order. */
const listed = (items: Book["items"]): Book => ({ items, ordered: true });

const order = (book: Book) =>
  book.items.map(({ id, is_default: isDefault }) => (isDefault ? `${id}*` : id));

// Mom was the default (the API lists Mom, Home, Work) and Work was made it on the device: Mom is
// drawn next, but Home may be the older one.
const GUESSED = withDefault(
  listed([{ ...MOM, is_default: true }, { ...HOME, is_default: false }, WORK]),
  "work",
);

describe("the book's edits keep the API's order, and say when they no longer can", () => {
  it("a new default moves to the top; the old one joins the others in front, a guess", () => {
    const moved = withDefault(listed(BOOK), "mom");
    expect(order(moved)).toEqual(["mom*", "home", "work"]);
    expect(moved.ordered).toBe(false);
    expect(order(GUESSED)).toEqual(["work*", "mom", "home"]);
  });

  it("the default made the default again, or an address the book lacks, changes nothing", () => {
    const book = listed(BOOK);
    expect(withDefault(book, "home")).toBe(book);
    expect(withDefault(book, "gone")).toBe(book);
    expect(withoutAddress(book, "gone")).toBe(book);
  });

  it("with one other address the order is known, whoever is the default", () => {
    const two = withDefault(listed([HOME, WORK]), "work");
    expect(order(two)).toEqual(["work*", "home"]);
    expect(two.ordered).toBe(true);
  });

  it("deleting the default of an ordered book makes the oldest remaining one the default", () => {
    const left = withoutAddress(listed(BOOK), "home");
    expect(order(left)).toEqual(["work*", "mom"]);
    expect(left.ordered).toBe(true);
    expect(withoutAddress(listed([HOME]), "home")).toEqual({ items: [], ordered: true });
  });

  it("deleting another address keeps the default and the order", () => {
    const left = withoutAddress(listed(BOOK), "work");
    expect(order(left)).toEqual(["home*", "mom"]);
    expect(left.ordered).toBe(true);
  });

  it("deleting the default of a book whose order is a guess draws no default", () => {
    const left = withoutAddress(GUESSED, "work");
    // The API promotes the oldest of Mom and Home: the device cannot tell which.
    expect(order(left)).toEqual(["mom", "home"]);
    expect(left.ordered).toBe(false);
  });

  it("the only address left is the default, whatever the order was worth", () => {
    const one = withoutAddress(withoutAddress(GUESSED, "work"), "mom");
    expect(order(one)).toEqual(["home*"]);
    expect(one.ordered).toBe(true);
  });

  it("a delete that leaves one other address makes the order known again", () => {
    const two = withoutAddress(GUESSED, "mom");
    expect(order(two)).toEqual(["work*", "home"]);
    expect(two.ordered).toBe(true);
  });

  it("a new address goes last, or first when the server made it the default", () => {
    const office = savedAddress({ id: "office", label: "Office", is_default: false });
    const added = withAdded(listed(BOOK), office);
    expect(order(added)).toEqual(["home*", "work", "mom", "office"]);
    expect(added.ordered).toBe(true);
    const first = withAdded(listed([]), { ...office, is_default: true });
    expect(order(first)).toEqual(["office*"]);
    expect(first.ordered).toBe(true);
    const crowned = withAdded(listed(BOOK), { ...office, is_default: true });
    expect(order(crowned)).toEqual(["office*", "home", "work", "mom"]);
    expect(crowned.ordered).toBe(false);
  });

  it("a new address alone in the book is its default, whatever its answer said", () => {
    // Added while the delete of the only address was unanswered: the server answered "not the
    // default", then deleted the other one.
    const office = savedAddress({ id: "office", label: "Office", is_default: false });
    const alone = withAdded(withoutAddress(listed([HOME]), "home"), office);
    expect(order(alone)).toEqual(["office*"]);
    expect(alone.ordered).toBe(true);
  });

  it("a new address the book already lists stays as listed, in its place", () => {
    // Its answer replayed over a GET that already has it, and a newer address after it: that list
    // read the address after the server added it, so the answer's copy is the older one.
    const lake = savedAddress({ id: "lake", label: "Lake", is_default: false });
    const book = listed([HOME, WORK, { ...MOM, label: "Mom" }, lake]);
    expect(withAdded(book, MOM)).toBe(book);
  });

  it("an edited address keeps its place and the chip as drawn, with the fields it sent", () => {
    const sent = { label: "Office", line1: "1 Bay St" };
    const edited = withFields(listed(BOOK), { ...WORK, ...sent }, sent);
    expect(order(edited)).toEqual(["home*", "work", "mom"]);
    expect(edited.items[1]).toEqual({ ...WORK, ...sent });
    expect(edited.ordered).toBe(true);
    // An answer from before a default change drawn since does not take the chip back.
    const house = { label: "House" };
    const moved = withFields(withDefault(listed(BOOK), "mom"), { ...HOME, ...house }, house);
    expect(order(moved)).toEqual(["mom*", "home", "work"]);
    expect(moved.items[1]).toEqual({ ...HOME, label: "House", is_default: false });
    // An address the book no longer has is not brought back.
    expect(withFields(listed([HOME, MOM]), { ...WORK, ...sent }, sent).items).toEqual([HOME, MOM]);
  });

  it("an edit's answer changes only what its request sent: the rest of it may be older", () => {
    // The street was changed by another write, already drawn; this answer was read before it.
    const drawn = listed([HOME, { ...WORK, line1: "250 Changed St" }, MOM]);
    const stale = { ...WORK, label: "Office", is_default: true };
    expect(withFields(drawn, stale, { label: "Office" }).items[1]).toEqual({
      ...WORK,
      label: "Office",
      line1: "250 Changed St",
    });
    // A request that sent no field of the address (the default alone) changes none.
    expect(withFields(drawn, stale, { is_default: true })).toEqual(drawn);
  });

  it("whether the ZIP is served goes with the ZIP, and the coordinates go together", () => {
    const answer = {
      ...WORK,
      label: "Old name",
      zip_code: "99950",
      served: false,
      lat: 40.5,
      lng: -74.25,
    };
    // The ZIP alone: `served` is the server's reading of that ZIP.
    expect(withFields(listed(BOOK), answer, { zip_code: "99950" }).items[1]).toEqual({
      ...WORK,
      zip_code: "99950",
      served: false,
    });
    // Another field alone: the ZIP of that answer and what the server read from it stay out.
    expect(withFields(listed(BOOK), answer, { line1: WORK.line1 }).items[1]).toEqual(WORK);
    expect(withFields(listed(BOOK), answer, { lat: 40.5, lng: -74.25 }).items[1]).toEqual({
      ...WORK,
      lat: 40.5,
      lng: -74.25,
    });
  });

  it("a field sent as null is changed only where null clears it", () => {
    const located = { ...WORK, line2: "Suite 12", lat: 40.5, lng: -74.25 };
    const book = listed([HOME, located, MOM]);
    const answer = { ...located, label: "Office", city: "Elsewhere", line2: null };
    // The unit is cleared; a null name or city asks for no change, so the answer's are not taken.
    expect(withFields(book, answer, { label: null, city: null, line2: null }).items[1]).toEqual({
      ...located,
      line2: null,
    });
    const cleared = { ...located, lat: null, lng: null };
    expect(withFields(book, cleared, { lat: null, lng: null }).items[1]).toEqual(cleared);
  });
});

describe("isLabelTaken", () => {
  it("compares as the API does: ignoring case and extra spaces", () => {
    expect(isLabelTaken(BOOK, "  home ")).toBe(true);
    expect(isLabelTaken(BOOK, "MOM'S   PLACE")).toBe(true);
    expect(isLabelTaken(BOOK, "Cabin")).toBe(false);
  });

  it("leaves out the address being edited", () => {
    expect(isLabelTaken(BOOK, "Work", "work")).toBe(false);
    expect(isLabelTaken(BOOK, "Home", "work")).toBe(true);
  });
});

describe("addressFailure", () => {
  it.each([
    [new NetworkError(false), "offline"],
    [new NetworkError(true), "offline"],
    [new ApiError(429, "rate_limited"), "rateLimited"],
    [new ApiError(409, "address_limit_reached"), "full"],
    [new ApiError(409, "address_label_taken"), "labelTaken"],
    [new ApiError(422, "validation_error"), "labelInvalid"],
    [new ApiError(404, "address_not_found"), "gone"],
    [new ApiError(500, "internal_error"), "generic"],
    [new Error("boom"), "generic"],
  ])("%s is %s", (error, failure) => {
    expect(addressFailure(error)).toBe(failure);
  });
});
