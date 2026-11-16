import type { components } from "@jack/shared";

/** The operations queue as the panel reads it from the API (D16.2, #81). */
export type QueueItem = components["schemas"]["QueueItem"];
export type QueuePage = components["schemas"]["QueuePage"];
export type QueueSummary = components["schemas"]["QueueSummary"];
export type RequestCard = components["schemas"]["RequestCard"];
export type RequestStatus = components["schemas"]["RequestStatus"];
export type Bucket = components["schemas"]["BucketFilter"];
export type Assigned = components["schemas"]["AssignedFilter"];
export type Category = components["schemas"]["CategoryOut"];

/** The buckets in the order the BDC works them (the issue's order), with a count each. */
export const BUCKET_TABS = [
  "new",
  "urgent",
  "waiting_customer",
  "waiting_pro",
  "quote_ready",
  "scheduled_today",
  "problems",
] as const satisfies readonly Exclude<Bucket, "all">[];

/**
 * The queue's tabs: the buckets, then the requests the reader holds (a request someone took
 * can sit in no bucket), then every request.
 */
export const QUEUE_TABS = [...BUCKET_TABS, "mine", "all"] as const;
export type QueueTab = (typeof QUEUE_TABS)[number];

export const REQUEST_STATUSES = [
  "received",
  "reviewing",
  "finding_pro",
  "quote_ready",
  "accepted",
  "expired",
  "cancelled",
] as const satisfies readonly RequestStatus[];

export const ASSIGNED = ["any", "me", "unassigned"] as const satisfies readonly Assigned[];

export const QUEUE_PATH = "/admin/queue";
export const REQUESTS_PATH = "/admin/requests";

/** The seconds between two reloads of the queue when QUEUE_REFRESH_SECONDS does not say. */
const DEFAULT_REFRESH_SECONDS = 30;

/** How often the open queue reads itself again: QUEUE_REFRESH_SECONDS, or half a minute. */
export function queueRefreshMs(): number {
  const seconds = Number(process.env.QUEUE_REFRESH_SECONDS);
  return (Number.isInteger(seconds) && seconds > 0 ? seconds : DEFAULT_REFRESH_SECONDS) * 1000;
}

type Param = string | string[] | undefined;

function one(value: Param): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** The tab from `?tab=`: new requests unless the URL names another tab. */
export function toTab(value: Param): QueueTab {
  return QUEUE_TABS.find((tab) => tab === value) ?? "new";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A request or category id is a UUID: anything else in the URL never reaches the API. */
export function isUuid(value: string): boolean {
  return UUID.test(value);
}

/** What the reader filtered by, as the URL carries it. Each value is one the API accepts. */
export type QueueFilters = {
  status?: RequestStatus;
  categoryId?: string;
  zip?: string;
  assigned?: Exclude<Assigned, "any">;
  q?: string;
};

/**
 * The filters in the URL. A value the API would refuse (an unknown status, a ZIP that is not
 * five digits, a search that is not part of a request code) is dropped here, so a mistyped
 * filter shows the unfiltered list instead of an error.
 */
export function toFilters(query: Record<string, Param>): QueueFilters {
  const status = REQUEST_STATUSES.find((value) => value === query.status);
  const category = one(query.category_id);
  const zip = one(query.zip)?.trim();
  const assigned = one(query.assigned);
  const q = one(query.q)?.trim();
  return {
    status,
    categoryId: category && isUuid(category) ? category : undefined,
    zip: zip && /^[0-9]{5}$/.test(zip) ? zip : undefined,
    assigned: assigned === "me" || assigned === "unassigned" ? assigned : undefined,
    q: q && /^[A-Za-z0-9-]{1,16}$/.test(q) ? q : undefined,
  };
}

/** The API's query for a tab and its filters. "Mine" is every request the reader holds. */
export function apiQuery(
  tab: QueueTab,
  filters: QueueFilters,
  cursor: string | undefined,
): {
  bucket: Bucket;
  status?: RequestStatus;
  category_id?: string;
  zip?: string;
  assigned?: Assigned;
  q?: string;
  cursor?: string;
} {
  return {
    bucket: tab === "mine" ? "all" : tab,
    status: filters.status,
    category_id: filters.categoryId,
    zip: filters.zip,
    assigned: tab === "mine" ? "me" : filters.assigned,
    q: filters.q,
    cursor,
  };
}

export function queueHref(
  tab: QueueTab,
  filters: QueueFilters = {},
  cursor?: string | null,
): string {
  const query = new URLSearchParams();
  if (tab !== "new") query.set("tab", tab);
  if (filters.status) query.set("status", filters.status);
  if (filters.categoryId) query.set("category_id", filters.categoryId);
  if (filters.zip) query.set("zip", filters.zip);
  if (filters.assigned && tab !== "mine") query.set("assigned", filters.assigned);
  if (filters.q) query.set("q", filters.q);
  if (cursor) query.set("cursor", cursor);
  const text = query.toString();
  return text ? `${QUEUE_PATH}?${text}` : QUEUE_PATH;
}

export function requestHref(requestId: string): string {
  return `${REQUESTS_PATH}/${requestId}`;
}

/** A category's name in the reader's language, else in English, else its slug. */
export function categoryName(
  category: { slug: string; names: Record<string, string> },
  locale: string,
): string {
  return category.names[locale] ?? category.names.en ?? category.slug;
}

/** The BDC still owes this request its first contact: the timer runs. */
export function awaitsFirstContact(item: Pick<QueueItem, "status" | "first_contact_at">): boolean {
  return (
    item.first_contact_at === null && (item.status === "received" || item.status === "reviewing")
  );
}

export type TimerTone = "calm" | "soon" | "late";

/**
 * Where the first-contact timer stands: the seconds left (negative once late) and its tone.
 * Calm for the first half of the time the BDC has, amber for the second half, red once the
 * time is up.
 */
export function contactTimer(
  nowMs: number,
  createdAt: string,
  dueAt: string,
): { seconds: number; tone: TimerTone } {
  const due = Date.parse(dueAt);
  const created = Date.parse(createdAt);
  const seconds = Math.ceil((due - nowMs) / 1000);
  if (nowMs >= due) return { seconds, tone: "late" };
  return { seconds, tone: nowMs - created >= (due - created) / 2 ? "soon" : "calm" };
}

/** A duration as a clock: 4:07 under an hour, 2h 05m under a day, 3d 4h beyond. */
export function formatClock(seconds: number): string {
  const total = Math.abs(seconds);
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}:${String(total % 60).padStart(2, "0")}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** How old a request is, in the largest whole unit: minutes, hours or days. */
export function ageOf(
  createdAt: string,
  nowMs: number,
): { unit: "minutes" | "hours" | "days"; count: number } {
  const minutes = Math.max(0, Math.floor((nowMs - Date.parse(createdAt)) / 60_000));
  if (minutes < 60) return { unit: "minutes", count: minutes };
  if (minutes < 60 * 24) return { unit: "hours", count: Math.floor(minutes / 60) };
  return { unit: "days", count: Math.floor(minutes / (60 * 24)) };
}

/** Cents as dollars in the reader's locale. Display only: money is computed by the API. */
export function formatUsd(cents: number, locale: string): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }).format(cents / 100);
}

const E164 = /^\+[1-9][0-9]{6,14}$/;

/**
 * The links that reach a customer. A phone that is not E.164 gives no `tel:` or `sms:` link.
 * The email keeps its one `@` and has everything else encoded, so the link can carry an
 * address and nothing more (no second recipient, no subject, no header); an email without a
 * name and a domain gives no link.
 */
export function contactLinks(customer: { phone: string | null; email: string }): {
  tel: string | null;
  sms: string | null;
  mailto: string | null;
} {
  const phone = customer.phone && E164.test(customer.phone) ? customer.phone : null;
  const at = customer.email.lastIndexOf("@");
  const [name, domain] = [customer.email.slice(0, at), customer.email.slice(at + 1)];
  return {
    tel: phone ? `tel:${phone}` : null,
    sms: phone ? `sms:${phone}` : null,
    mailto:
      at > 0 && domain !== ""
        ? `mailto:${encodeURIComponent(name)}@${encodeURIComponent(domain)}`
        : null,
  };
}
