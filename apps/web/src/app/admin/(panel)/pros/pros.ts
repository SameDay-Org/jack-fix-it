import type { components } from "@jack/shared";

/** Pros as the panel reads them from the API to approve or reject them (D7.4, #41). */
export type ProStatus = components["schemas"]["ProVerificationStatus"];
export type ProItem = components["schemas"]["StaffProItem"];
export type ProPage = components["schemas"]["StaffProPage"];
export type Pro = components["schemas"]["StaffProOut"];
export type ProDocument = components["schemas"]["StaffDocumentOut"];
export type DocumentType = components["schemas"]["ProDocumentType"];
export type ApprovalBlocker = components["schemas"]["ApprovalBlocker"];
export type Category = components["schemas"]["CategorySummary"];
export type Decision = components["schemas"]["ReviewDecision"];

/** The list's tabs, in order: the pros waiting for a decision come first. */
export const PRO_STATUSES = [
  "pending",
  "approved",
  "rejected",
] as const satisfies readonly ProStatus[];

export const DECISIONS = ["approved", "rejected"] as const satisfies readonly Decision[];

/** The longest reason the API takes for a rejection (ProReviewIn.reason); it checks again. */
export const REASON_MAX_LENGTH = 500;

export const PROS_PATH = "/admin/pros";

/** The list's tab from `?status=`: pending pros unless the URL names another status. */
export function toStatus(value: string | string[] | undefined): ProStatus {
  return PRO_STATUSES.find((status) => status === value) ?? "pending";
}

export function isDecision(value: unknown): value is Decision {
  return DECISIONS.some((decision) => decision === value);
}

export function listHref(status: ProStatus, cursor?: string | null): string {
  const query = new URLSearchParams();
  if (status !== "pending") query.set("status", status);
  if (cursor) query.set("cursor", cursor);
  const text = query.toString();
  return text ? `${PROS_PATH}?${text}` : PROS_PATH;
}

export function proHref(proId: string): string {
  return `${PROS_PATH}/${proId}`;
}

/** A category's name in the reader's language, else in English, else its slug. */
export function categoryName(category: Category, locale: string): string {
  return category.names[locale] ?? category.names.en ?? category.slug;
}

/** A calendar date ("2027-01-31") as the reader's locale writes it; no time zone moves it. */
export function formatDay(day: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(
    new Date(`${day}T00:00:00Z`),
  );
}

/** Whether a document's expiry date is past, by the UTC date the API also goes by. */
export function isExpired(expiresOn: string | null, now: Date): boolean {
  return expiresOn !== null && expiresOn < now.toISOString().slice(0, 10);
}
