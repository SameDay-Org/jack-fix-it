import type { StatusTone } from "@/components/ui";
import {
  documentRows,
  type DocumentRow,
  type MyDocuments,
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
 * - `requests`: approved, so the new requests are listed;
 * - `onboarding`: pending or rejected, so the home shows what is left to do instead. A pro who
 *   is not approved is sent no request, and the app asks for none.
 */
export type HomeMode = "requests" | "onboarding";

export const homeMode = (profile: ProProfile): HomeMode =>
  profile.verification_status === "approved" ? "requests" : "onboarding";

/**
 * An approved pro receives requests only once payouts are on as well. Until then that is the
 * step left, and the app has no screen for it yet (#277).
 */
export const awaitsPayouts = (profile: ProProfile): boolean =>
  profile.verification_status === "approved" && !profile.payouts_enabled;

/** The home says where the review stands unless there is nothing left to say: approved and paid out. */
export const showsBanner = (profile: ProProfile): boolean =>
  profile.verification_status !== "approved" || !profile.payouts_enabled;

/** A required document counts as sent while it waits for the review or was approved. */
const isSent = ({ state }: DocumentRow): boolean => state === "pending" || state === "approved";

export type DocumentsChecklist = {
  /** The required types, in the API's order. */
  rows: readonly DocumentRow[];
  /** How many of them are sent. */
  sent: number;
  /** Every required document is sent: nothing left to ask for. */
  complete: boolean;
};

/** The required documents and how many are in: what the home's documents checklist draws. */
export function documentsChecklist(data: MyDocuments): DocumentsChecklist {
  const rows = documentRows(data).filter(({ type }) => data.required_types.includes(type));
  const sent = rows.filter(isSent).length;
  return { rows, sent, complete: sent === rows.length };
}

/** The documents the review rejected, required or not: each carries the reason to show. */
export const rejectedDocuments = (data: MyDocuments): DocumentRow[] =>
  documentRows(data).filter(({ state }) => state === "rejected");
