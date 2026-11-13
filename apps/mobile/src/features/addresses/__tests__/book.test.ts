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

  it("a new address the book already lists keeps its place", () => {
    // Its answer replayed over a GET that already has it, and a newer address after it.
    const lake = savedAddress({ id: "lake", label: "Lake", is_default: false });
    const book = listed([HOME, WORK, MOM, lake]);
    expect(order(withAdded(book, { ...MOM, label: "Mom" }))).toEqual([
      "home*",
      "work",
      "mom",
      "lake",
    ]);
  });

  it("an edited address keeps its place and the chip as drawn, with the server's fields", () => {
    const edited = withFields(listed(BOOK), { ...WORK, label: "Office", line1: "1 Bay St" });
    expect(order(edited)).toEqual(["home*", "work", "mom"]);
    expect(edited.items[1]).toMatchObject({ label: "Office", line1: "1 Bay St" });
    expect(edited.ordered).toBe(true);
    // An answer from before a default change drawn since does not take the chip back.
    const moved = withFields(withDefault(listed(BOOK), "mom"), { ...HOME, label: "House" });
    expect(order(moved)).toEqual(["mom*", "home", "work"]);
    expect(moved.items[1]).toMatchObject({ label: "House", is_default: false });
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
