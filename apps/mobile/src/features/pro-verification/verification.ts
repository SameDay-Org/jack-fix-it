import type { StatusTone } from "@/components/ui";
import {
  documentRows,
  type DocumentRow,
  type MyDocuments,
  type ProDocument,
} from "@/features/pro-documents/documents";
import type { ProProfile } from "@/features/pro-profile";

/** Where the platform's review of the pro stands (`ProProfileOut.verification_status`). */
export type VerificationStatus = ProProfile["verification_status"];

export const STATUS_TONE: Record<VerificationStatus, StatusTone> = {
  pending: "info",
  approved: "success",
  rejected: "danger",
};

/**
 * What the pro's home is for:
 * - `requests`: approved and with payouts on, so the new requests are listed;
 * - `onboarding`: anything short of that, so the home shows where the pro stands and what is
 *   left instead. The API sends a request only to a pro who is approved and can be paid: for
 *   anyone else the app asks for none, since an empty list would read as "no work near you".
 */
export type HomeMode = "requests" | "onboarding";

export const homeMode = (profile: ProProfile): HomeMode =>
  profile.verification_status === "approved" && profile.payouts_enabled ? "requests" : "onboarding";

/**
 * An approved pro receives requests only once payouts are on as well. Until then that is the
 * step left: the payout screen (#277).
 */
export const awaitsPayouts = (profile: ProProfile): boolean =>
  profile.verification_status === "approved" && !profile.payouts_enabled;

/** Today as the API reads `expires_on`: the UTC date ("2026-11-17"). */
const utcToday = (now: Date): string => now.toISOString().slice(0, "YYYY-MM-DD".length);

/**
 * An approved document whose `expires_on` is before today (UTC) no longer covers its type (the
 * Foreman's decision on #38): the pro uploads a renewed one. Expiring today, or with no expiry,
 * it still covers it. The API's `missing_types` does not look at expiry, so the app reads
 * `expires_on` itself.
 */
export const isExpired = (document: ProDocument | undefined, now: Date): boolean =>
  document?.status === "approved" &&
  document.expires_on !== null &&
  document.expires_on < utcToday(now);

/** A required document's row on the checklist: an expired one reads as missing again. */
export type ChecklistRow = DocumentRow & {
  /** Approved, but past its expiry: missing until a renewed one is uploaded. */
  expired: boolean;
};

/** A required document counts as sent while it waits for the review or was approved. */
const isSent = ({ state }: ChecklistRow): boolean => state === "pending" || state === "approved";

export type DocumentsChecklist = {
  /** The required types, in the API's order. */
  rows: readonly ChecklistRow[];
  /** How many of them are sent. */
  sent: number;
  /** Every required document is sent: nothing left to ask for. */
  complete: boolean;
};

/** The required documents and how many are in: what the home's documents checklist draws. */
export function documentsChecklist(data: MyDocuments, now: Date = new Date()): DocumentsChecklist {
  const rows = documentRows(data)
    .filter(({ type }) => data.required_types.includes(type))
    .map((row): ChecklistRow =>
      isExpired(row.document, now)
        ? { ...row, state: "missing", expired: true }
        : { ...row, expired: false },
    );
  const sent = rows.filter(isSent).length;
  return { rows, sent, complete: sent === rows.length };
}

/** The documents the review rejected, required or not: each carries the reason to show. */
export const rejectedDocuments = (data: MyDocuments): DocumentRow[] =>
  documentRows(data).filter(({ state }) => state === "rejected");
