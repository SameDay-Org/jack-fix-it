import { document, documents, NOTHING_SENT } from "../../pro-documents/__tests__/helpers";
import type { ProDocument } from "../../pro-documents/documents";
import { EMPTY_PROFILE, FULL_PROFILE } from "../../pro-profile/__tests__/helpers";
import { awaitsPayouts, documentsChecklist, homeMode, rejectedDocuments } from "../verification";

jest.mock("@/api", () => jest.requireActual("../../../api/errors"));

const PENDING = EMPTY_PROFILE;
const REJECTED = { ...FULL_PROFILE, verification_status: "rejected" as const };
const APPROVED = { ...FULL_PROFILE, verification_status: "approved" as const };
const PAID_OUT = { ...APPROVED, payouts_enabled: true };

describe("the pro's home by verification status", () => {
  it("lists requests only for a pro who is approved and has payouts on", () => {
    expect(homeMode(PENDING)).toBe("onboarding");
    expect(homeMode(REJECTED)).toBe("onboarding");
    // Approved, but the API sends this pro no request until payouts are on.
    expect(homeMode(APPROVED)).toBe("onboarding");
    expect(homeMode(PAID_OUT)).toBe("requests");
    // Payouts alone open nothing.
    expect(homeMode({ ...PENDING, payouts_enabled: true })).toBe("onboarding");
    expect(homeMode({ ...REJECTED, payouts_enabled: true })).toBe("onboarding");
  });

  it("an approved pro still waits for payouts until they are on", () => {
    expect(awaitsPayouts(APPROVED)).toBe(true);
    expect(awaitsPayouts(PAID_OUT)).toBe(false);
    // Payouts mean nothing before the approval.
    expect(awaitsPayouts(PENDING)).toBe(false);
  });
});

describe("documentsChecklist", () => {
  it("has nothing sent for a new pro", () => {
    expect(documentsChecklist(NOTHING_SENT)).toMatchObject({ sent: 0, complete: false });
    expect(documentsChecklist(NOTHING_SENT).rows.map(({ type }) => type)).toEqual([
      "id",
      "insurance",
    ]);
  });

  it("counts a document in review or approved as sent, and a rejected one as not", () => {
    const data = documents(
      [
        document({ doc_type: "id", status: "approved" }),
        document({ doc_type: "license", status: "pending" }),
        document({ doc_type: "insurance", status: "rejected" }),
      ],
      ["id", "license", "insurance"],
    );

    expect(documentsChecklist(data)).toMatchObject({ sent: 2, complete: false });
  });

  it("is complete once every required document is in, whatever else was sent", () => {
    const data = documents([
      document({ doc_type: "id", status: "pending" }),
      document({ doc_type: "insurance", status: "approved" }),
      // Not required: it is not a step, even rejected.
      document({ doc_type: "license", status: "rejected" }),
    ]);

    expect(documentsChecklist(data)).toMatchObject({ sent: 2, complete: true });
    expect(documentsChecklist(data).rows).toHaveLength(2);
  });

  describe("an approved document past its expiry (before today, UTC)", () => {
    // 9 PM in Florida on Nov 16 is already Nov 17 in UTC, the day the API reads.
    const NOW = new Date("2026-11-17T02:00:00Z");
    const withInsurance = (insurance: Partial<ProDocument>) =>
      documents([
        document({ doc_type: "id", status: "approved" }),
        document({ doc_type: "insurance", status: "approved", ...insurance }),
      ]);

    it("counts as missing again: its row, the count and the completion", () => {
      const checklist = documentsChecklist(withInsurance({ expires_on: "2026-11-16" }), NOW);

      expect(checklist).toMatchObject({ sent: 1, complete: false });
      expect(checklist.rows.map(({ type, state, expired }) => [type, state, expired])).toEqual([
        ["id", "approved", false],
        ["insurance", "missing", true],
      ]);
    });

    it.each([
      ["expiring today", "2026-11-17"],
      ["expiring later", "2027-01-01"],
      ["with no expiry", null],
    ])("still counts as sent %s", (_, expires_on) => {
      const checklist = documentsChecklist(withInsurance({ expires_on }), NOW);

      expect(checklist).toMatchObject({ sent: 2, complete: true });
      expect(checklist.rows.every(({ expired }) => !expired)).toBe(true);
    });

    it("applies to an approved document only: one in review keeps waiting for its review", () => {
      const checklist = documentsChecklist(
        withInsurance({ status: "pending", expires_on: "2026-11-16" }),
        NOW,
      );

      expect(checklist).toMatchObject({ sent: 2, complete: true });
    });

    it("leaves a type that is not required out", () => {
      const data = documents([
        document({ doc_type: "id", status: "approved" }),
        document({ doc_type: "insurance", status: "approved" }),
        document({ doc_type: "license", status: "approved", expires_on: "2026-11-16" }),
      ]);

      expect(documentsChecklist(data, NOW)).toMatchObject({ sent: 2, complete: true });
    });
  });
});

describe("rejectedDocuments", () => {
  it("lists every rejected document with its reason, required or not", () => {
    const data = documents([
      document({ doc_type: "id", status: "rejected", rejection_reason: "Too dark" }),
      document({ doc_type: "insurance", status: "approved" }),
      document({ doc_type: "license", status: "rejected", rejection_reason: "Expired" }),
    ]);

    expect(
      rejectedDocuments(data).map(({ type, document: rejected }) => [
        type,
        rejected?.rejection_reason,
      ]),
    ).toEqual([
      ["id", "Too dark"],
      ["license", "Expired"],
    ]);
  });

  it("is empty when the review rejected no document", () => {
    expect(rejectedDocuments(NOTHING_SENT)).toEqual([]);
  });
});
