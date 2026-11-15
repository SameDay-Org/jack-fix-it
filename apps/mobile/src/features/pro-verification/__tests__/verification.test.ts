import { document, documents, NOTHING_SENT } from "../../pro-documents/__tests__/helpers";
import { EMPTY_PROFILE, FULL_PROFILE } from "../../pro-profile/__tests__/helpers";
import {
  awaitsPayouts,
  documentsChecklist,
  homeMode,
  rejectedDocuments,
  showsBanner,
} from "../verification";

jest.mock("@/api", () => jest.requireActual("../../../api/errors"));

const PENDING = EMPTY_PROFILE;
const REJECTED = { ...FULL_PROFILE, verification_status: "rejected" as const };
const APPROVED = { ...FULL_PROFILE, verification_status: "approved" as const };
const PAID_OUT = { ...APPROVED, payouts_enabled: true };

describe("the pro's home by verification status", () => {
  it("lists requests for an approved pro only", () => {
    expect(homeMode(PENDING)).toBe("onboarding");
    expect(homeMode(REJECTED)).toBe("onboarding");
    expect(homeMode(APPROVED)).toBe("requests");
    expect(homeMode(PAID_OUT)).toBe("requests");
  });

  it("says where the review stands until the pro is approved and paid out", () => {
    expect([PENDING, REJECTED, APPROVED, PAID_OUT].map(showsBanner)).toEqual([
      true,
      true,
      true,
      false,
    ]);
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
