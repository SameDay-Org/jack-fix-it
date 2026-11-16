import type { GetResponse } from "@/api";

/** GET /v1/pros/me/documents: the latest document of each type, and what is required. */
export type MyDocuments = GetResponse<"/v1/pros/me/documents">;
export type ProDocument = MyDocuments["documents"][number];
export type DocumentType = ProDocument["doc_type"];

/** Every type the API knows, in the order the screen lists the ones that are not required. */
export const DOCUMENT_TYPES: readonly DocumentType[] = ["id", "license", "insurance"];

export const isDocumentType = (value: unknown): value is DocumentType =>
  DOCUMENT_TYPES.some((type) => type === value);

/** Where a type stands: nothing sent, sent and waiting for the review, or reviewed. */
export type DocumentState = "missing" | "pending" | "approved" | "rejected";

export type DocumentRow = {
  type: DocumentType;
  state: DocumentState;
  /** The latest document of the type; none while it is missing. */
  document: ProDocument | undefined;
};

/** One type's row: its latest document decides the state (a superseded one counts as none). */
export function documentRow(data: MyDocuments, type: DocumentType): DocumentRow {
  const document = data.documents.find(
    (candidate) => candidate.doc_type === type && candidate.status !== "superseded",
  );
  const state: DocumentState =
    document === undefined || document.status === "superseded" ? "missing" : document.status;
  return { type, state, document };
}

/**
 * The rows of the list: the required types in the API's order, then any other type the pro has
 * a document of (a license sent before its category was dropped).
 */
export function documentRows(data: MyDocuments): DocumentRow[] {
  const others = DOCUMENT_TYPES.filter(
    (type) =>
      !data.required_types.includes(type) &&
      data.documents.some((document) => document.doc_type === type),
  );
  return [...data.required_types, ...others].map((type) => documentRow(data, type));
}

/**
 * The list as it stands once `document` was submitted, before the server lists it again: it is
 * the latest of its type (the pending one it replaces is superseded), and its type is no longer
 * missing.
 */
export function withSubmitted(data: MyDocuments, document: ProDocument): MyDocuments {
  return {
    ...data,
    documents: [
      document,
      ...data.documents.filter((other) => other.doc_type !== document.doc_type),
    ],
    missing_types: data.missing_types.filter((type) => type !== document.doc_type),
  };
}

/** An ID has no expiry to give; a license and an insurance policy may. */
export const takesExpiry = (type: DocumentType): boolean => type !== "id";

const DATE_DIGITS = 8;

/** The digits typed, shown as MM/DD/YYYY as far as they go: "0312" reads "03/12". */
export function maskDate(text: string): string {
  const digits = text.replace(/\D/g, "").slice(0, DATE_DIGITS);
  return [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4)].filter(Boolean).join("/");
}

/**
 * The typed expiry date as the API takes it ("2027-03-12"), `null` for an empty field, and
 * `undefined` when the text is not a real day (a month 13, a February 30, a year cut short).
 */
export function expiryIsoOf(text: string): string | null | undefined {
  if (text.trim() === "") return null;
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text.trim());
  if (!match) return undefined;
  const [month, day, year] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const real =
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  return real ? date.toISOString().slice(0, "YYYY-MM-DD".length) : undefined;
}

export type ExpiryError = "invalid" | "past";

/**
 * Why the typed expiry cannot be sent: not a date, or before today. "Today" is the UTC date, as
 * the API reads it (`expires_on`: today or later, UTC), so the two never disagree in the evening.
 */
export function expiryError(text: string, now: Date = new Date()): ExpiryError | undefined {
  const iso = expiryIsoOf(text);
  if (iso === undefined) return "invalid";
  if (iso === null) return undefined;
  return iso < now.toISOString().slice(0, "YYYY-MM-DD".length) ? "past" : undefined;
}
