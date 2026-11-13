import { ApiError, NetworkError } from "@/api";

import { savedAddress } from "../../request/__tests__/helpers";
import {
  addressFailure,
  isLabelTaken,
  nextDefaultAfter,
  withAdded,
  withDefault,
  withoutAddress,
  withUpdated,
} from "../book";

jest.mock("@/api", () => jest.requireActual("../../../api/errors"));

// As the API lists them: the default first, then the oldest first.
const HOME = savedAddress({ id: "home", label: "Home", is_default: true });
const WORK = savedAddress({ id: "work", label: "Work", is_default: false });
const MOM = savedAddress({ id: "mom", label: "Mom's place", is_default: false });
const BOOK = [HOME, WORK, MOM];

const order = (book: { id: string; is_default: boolean }[]) =>
  book.map(({ id, is_default: isDefault }) => (isDefault ? `${id}*` : id));

describe("the book's edits keep the API's order", () => {
  it("a new default moves to the top; the others keep their order", () => {
    expect(order(withDefault(BOOK, "mom"))).toEqual(["mom*", "home", "work"]);
    expect(order(withDefault(BOOK, "home"))).toEqual(["home*", "work", "mom"]);
    expect(order(withDefault(BOOK, "gone"))).toEqual(["home*", "work", "mom"]);
  });

  it("deleting the default makes the oldest remaining one the default, as the API does", () => {
    expect(order(withoutAddress(BOOK, "home"))).toEqual(["work*", "mom"]);
    expect(order(withoutAddress(BOOK, "work"))).toEqual(["home*", "mom"]);
    expect(withoutAddress([HOME], "home")).toEqual([]);
  });

  it("a new address goes last, or first when the server made it the default", () => {
    const office = savedAddress({ id: "office", label: "Office", is_default: false });
    expect(order(withAdded(BOOK, office))).toEqual(["home*", "work", "mom", "office"]);
    expect(order(withAdded([], { ...office, is_default: true }))).toEqual(["office*"]);
    expect(order(withAdded(BOOK, { ...office, is_default: true }))).toEqual([
      "office*",
      "home",
      "work",
      "mom",
    ]);
  });

  it("an edited address keeps its place with the server's fields", () => {
    const edited = withUpdated(BOOK, { ...WORK, label: "Office", line1: "1 Bay St" });
    expect(order(edited)).toEqual(["home*", "work", "mom"]);
    expect(edited[1]).toMatchObject({ label: "Office", line1: "1 Bay St" });
  });
});

describe("nextDefaultAfter: who becomes the default when the default is deleted", () => {
  it("is the first of the others in a book as the server listed it: the oldest", () => {
    expect(nextDefaultAfter(BOOK, "home", true)?.id).toBe("work");
  });

  it("is unknown in a book the device redrew: the others are no longer oldest first", () => {
    // Mom was the default (the API lists Mom, Home, Work) and Work was made it on the device:
    // Mom is drawn next, but Home may be the older one.
    const redrawn = withDefault([{ ...MOM, is_default: true }, HOME, WORK], "work");
    expect(order(redrawn)).toEqual(["work*", "mom", "home"]);
    expect(nextDefaultAfter(redrawn, "work", false)).toBeUndefined();
  });

  it("is the only other address, whatever the order is worth", () => {
    expect(nextDefaultAfter(withDefault([HOME, WORK], "work"), "work", false)?.id).toBe("home");
  });

  it("is no one when the book has no other address", () => {
    expect(nextDefaultAfter([HOME], "home", true)).toBeUndefined();
    expect(nextDefaultAfter([HOME], "home", false)).toBeUndefined();
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
