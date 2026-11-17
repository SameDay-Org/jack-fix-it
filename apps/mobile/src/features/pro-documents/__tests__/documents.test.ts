import { ApiError, NetworkError } from "@/api";
import i18n from "@/i18n";

import { documentFailure } from "../api";
import {
  documentRow,
  documentRows,
  expiryError,
  expiryIsoOf,
  isDocumentType,
  maskDate,
  takesExpiry,
  withSubmitted,
} from "../documents";
import { documentFacts, formatDay } from "../format";
import { document, documents, NOTHING_SENT } from "./helpers";

jest.mock("@/api", () => jest.requireActual("../../../api/errors"));

const states = (data: Parameters<typeof documentRows>[0]) =>
  documentRows(data).map(({ type, state }) => `${type}:${state}`);

describe("documentRows", () => {
  it("lists the required types in the API's order, missing until one is sent", () => {
    expect(states(NOTHING_SENT)).toEqual(["id:missing", "insurance:missing"]);
    expect(states({ ...NOTHING_SENT, required_types: ["id", "license", "insurance"] })).toEqual([
      "id:missing",
      "license:missing",
      "insurance:missing",
    ]);
  });

  it("takes each type's state from its latest document", () => {
    const data = documents(
      [
        document({ doc_type: "id", status: "approved" }),
        document({ doc_type: "license", status: "rejected", rejection_reason: "Blurry" }),
        document({ doc_type: "insurance", status: "pending" }),
      ],
      ["id", "license", "insurance"],
    );

    expect(states(data)).toEqual(["id:approved", "license:rejected", "insurance:pending"]);
    expect(documentRow(data, "license").document?.rejection_reason).toBe("Blurry");
  });

  it("lists a type that is not required when the pro has a document of it", () => {
    const data = documents([document({ doc_type: "license", status: "approved" })]);

    expect(states(data)).toEqual(["id:missing", "insurance:missing", "license:approved"]);
  });

  it("reads a superseded document as none", () => {
    const data = documents([document({ doc_type: "id", status: "superseded" })]);

    expect(documentRow(data, "id")).toEqual({ type: "id", state: "missing", document: undefined });
  });
});

describe("withSubmitted", () => {
  it("puts the new document in the place of the pending one of its type", () => {
    const pending = document({ doc_type: "insurance", status: "pending" });
    const id = document({ doc_type: "id", status: "approved" });
    const sent = document({ doc_type: "insurance", status: "pending" });

    const next = withSubmitted(documents([id, pending]), sent);

    expect(next.documents).toEqual([sent, id]);
    expect(next.missing_types).toEqual([]);
  });

  it("takes the type out of the missing ones", () => {
    const sent = document({ doc_type: "id" });

    expect(withSubmitted(NOTHING_SENT, sent)).toMatchObject({
      documents: [sent],
      missing_types: ["insurance"],
    });
  });
});

describe("the expiry date", () => {
  it("only a license and an insurance policy take one", () => {
    expect(
      ["id", "license", "insurance"].filter((type) => isDocumentType(type) && takesExpiry(type)),
    ).toEqual(["license", "insurance"]);
    expect(isDocumentType("passport")).toBe(false);
  });

  it.each([
    ["0", "0"],
    ["03", "03"],
    ["031", "03/1"],
    ["0312", "03/12"],
    ["03122", "03/12/2"],
    ["03122027", "03/12/2027"],
    ["03/12/2027", "03/12/2027"],
    ["031220279", "03/12/2027"],
    ["03/", "03"],
    ["ab", ""],
  ])("shows %p as %p while it is typed", (typed, shown) => {
    expect(maskDate(typed)).toBe(shown);
  });

  it("reads MM/DD/YYYY as the API's date, and an empty field as none", () => {
    expect(expiryIsoOf("03/12/2027")).toBe("2027-03-12");
    expect(expiryIsoOf("02/29/2028")).toBe("2028-02-29");
    expect(expiryIsoOf("")).toBeNull();
    expect(expiryIsoOf("   ")).toBeNull();
  });

  it.each([
    "13/01/2027",
    "02/30/2027",
    "02/29/2027",
    "00/10/2027",
    "03/12/27",
    "03/12",
    "3/1/2027",
  ])("refuses %p, which is not a day", (typed) => {
    expect(expiryIsoOf(typed)).toBeUndefined();
    expect(expiryError(typed)).toBe("invalid");
  });

  it("takes today or later, and refuses the day before", () => {
    const now = new Date("2026-11-15T16:00:00Z");

    expect(expiryError("", now)).toBeUndefined();
    expect(expiryError("11/15/2026", now)).toBeUndefined();
    expect(expiryError("11/16/2026", now)).toBeUndefined();
    expect(expiryError("11/14/2026", now)).toBe("past");
  });

  it("reads today as the API does, in UTC: an evening in Florida is already tomorrow", () => {
    // 9 PM on Nov 15 in Florida is 02:00 on Nov 16 in UTC.
    const evening = new Date("2026-11-16T02:00:00Z");

    expect(expiryError("11/15/2026", evening)).toBe("past");
    expect(expiryError("11/16/2026", evening)).toBeUndefined();
  });
});

describe("what a row says under the name", () => {
  const t = i18n.t.bind(i18n);

  it("the reason of a rejection, then the expiry", () => {
    const rejected = document({
      doc_type: "insurance",
      status: "rejected",
      rejection_reason: " The policy number is cut off. ",
      expires_on: "2027-03-12",
    });

    expect(documentFacts(t, documentRow(documents([rejected]), "insurance"))).toEqual([
      "Reason: The policy number is cut off.",
      "Expires Mar 12, 2027",
    ]);
  });

  it("no reason for a document that was not rejected, and nothing for a missing one", () => {
    const approved = document({ doc_type: "id", status: "approved", rejection_reason: "old" });

    expect(documentFacts(t, documentRow(documents([approved]), "id"))).toEqual([]);
    expect(documentFacts(t, documentRow(NOTHING_SENT, "id"))).toEqual([]);
  });

  it("names the day the document carries, never the day before", () => {
    expect(formatDay("2027-01-01", "en-US")).toBe("Jan 1, 2027");
  });
});

describe("documentFailure", () => {
  it.each([
    [new NetworkError(false), "offline"],
    [new NetworkError(true), "offline"],
    [new ApiError(422, "invalid_media"), "photo"],
    [new ApiError(422, "validation_error"), "generic"],
    [new ApiError(403, "forbidden"), "generic"],
    [new ApiError(500, undefined), "generic"],
  ])("%p reads as %s", (error, failure) => {
    expect(documentFailure(error)).toBe(failure);
  });
});
