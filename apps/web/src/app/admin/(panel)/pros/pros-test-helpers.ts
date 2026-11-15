/** Fixtures of the pros page tests: pros and documents as the API returns them. Tests only. */
import type { Pro, ProDocument, ProItem, ProPage } from "./pros";

export const PRO_ID = "4a1e0f3a-1111-4222-8333-944455556641";
export const OTHER_PRO_ID = "4a1e0f3a-2222-4333-8444-055566667741";
export const DOCUMENT_ID = "d0c0f3a5-1111-4222-8333-944455556641";
export const OLD_DOCUMENT_ID = "d0c0f3a5-2222-4333-8444-055566667741";
export const FILE_URL = "https://storage.test.invalid/get/u/doc.pdf?sig=probe";
export const BIO = "Plumber since 2009.\nCall me at 305-555-0141 <b>now</b>.";

const PLUMBING = {
  id: "c0a7e901-1111-4222-8333-944455556641",
  slug: "plumbing",
  names: { en: "Plumbing", es: "Plomería" },
};

export function item(extra: Partial<ProItem> = {}): ProItem {
  return {
    id: PRO_ID,
    name: "Lucía R.",
    verification_status: "pending",
    payouts_enabled: false,
    categories: [PLUMBING],
    zip_count: 3,
    documents: { pending: 2, approved: 1, rejected: 0 },
    submitted_at: "2026-11-07T14:30:00Z",
    created_at: "2026-11-06T10:00:00Z",
    ...extra,
  };
}

export function page(items: ProItem[], extra: Partial<Omit<ProPage, "items">> = {}): ProPage {
  return {
    items,
    next_cursor: null,
    counts: { pending: 7, approved: 12, rejected: 1 },
    ...extra,
  };
}

export function document(extra: Partial<ProDocument> = {}): ProDocument {
  return {
    id: DOCUMENT_ID,
    doc_type: "id",
    status: "pending",
    rejection_reason: null,
    expires_on: "2031-01-31",
    created_at: "2026-11-07T14:30:00Z",
    reviewed_at: null,
    url: FILE_URL,
    expires_at: "2026-11-07T14:35:00Z",
    ...extra,
  };
}

export function pro(extra: Partial<Pro> = {}): Pro {
  return {
    id: PRO_ID,
    user_id: "3c1e0f3a-2222-4333-8444-655566667741",
    name: "Lucía R.",
    verification_status: "pending",
    rejection_reason: null,
    reviewed_at: null,
    payouts_enabled: false,
    bio: BIO,
    years_of_experience: 9,
    photo: null,
    categories: [PLUMBING],
    service_areas: [
      {
        id: "a7ea0f3a-1111-4222-8333-944455556641",
        zip_code: "33301",
        city: "Fort Lauderdale",
        state: "FL",
        region: "South Florida",
      },
    ],
    documents: [document()],
    history: [],
    required_types: ["id", "insurance"],
    missing_types: ["insurance"],
    approval_blockers: [
      { kind: "document_missing", doc_type: "id" },
      { kind: "document_missing", doc_type: "insurance" },
    ],
    created_at: "2026-11-06T10:00:00Z",
    ...extra,
  };
}
