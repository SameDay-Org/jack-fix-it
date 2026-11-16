import type { MyDocuments, ProDocument } from "../documents";

export {
  navigation,
  newQueryClient,
  renderWithQuery,
  routerMock,
  signedIn,
} from "../../pro-jobs/__tests__/helpers";
export { apiMock } from "../../pro-profile/__tests__/helpers";

/** Every signed URL of the fixtures carries this host: none may reach a log. */
export const URL_MARK = "storage.test";

let serial = 0;

/** A document as the API lists it; the URL is a placeholder signed for a long time. */
export const document = (overrides: Partial<ProDocument> = {}): ProDocument => {
  serial += 1;
  return {
    id: `00000000-0000-4000-8000-0000000009${String(serial).padStart(2, "0")}`,
    doc_type: "id",
    status: "pending",
    rejection_reason: null,
    expires_on: null,
    created_at: "2026-11-10T15:00:00Z",
    url: `https://${URL_MARK}/pro-documents/${serial}.jpg?X-Amz-Signature=sig-${serial}`,
    expires_at: "2999-01-01T00:00:00Z",
    ...overrides,
  };
};

/** What a pro with nothing sent sees: an ID and an insurance to send. */
export const NOTHING_SENT: MyDocuments = {
  documents: [],
  history: [],
  required_types: ["id", "insurance"],
  missing_types: ["id", "insurance"],
};

/** The list with these latest documents; a type is missing unless one is pending or approved. */
export function documents(
  latest: ProDocument[],
  required: MyDocuments["required_types"] = ["id", "insurance"],
): MyDocuments {
  const covered = latest
    .filter(({ status }) => status === "pending" || status === "approved")
    .map(({ doc_type }) => doc_type);
  return {
    documents: latest,
    history: [],
    required_types: required,
    missing_types: required.filter((type) => !covered.includes(type)),
  };
}
