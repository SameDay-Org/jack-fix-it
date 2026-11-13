import type { components } from "@jack/shared";

/** Support tickets as the panel reads them from the API ("Talk to Jack", #274). */
export type TicketStatus = components["schemas"]["TicketStatus"];
export type TicketItem = components["schemas"]["StaffSupportTicketItem"];
export type Ticket = components["schemas"]["StaffSupportTicketOut"];

export const TICKET_STATUSES = [
  "open",
  "in_progress",
  "closed",
] as const satisfies readonly TicketStatus[];

/** The list shows one status, or every ticket. */
export type TicketFilter = TicketStatus | "all";
export const TICKET_FILTERS: readonly TicketFilter[] = [...TICKET_STATUSES, "all"];

export const SUPPORT_PATH = "/admin/support";

export function isTicketStatus(value: unknown): value is TicketStatus {
  return TICKET_STATUSES.some((status) => status === value);
}

/** The list's filter from `?status=`: open tickets unless the URL names another filter. */
export function toFilter(value: string | string[] | undefined): TicketFilter {
  return TICKET_FILTERS.find((filter) => filter === value) ?? "open";
}

/** One value of a query parameter, when the URL gives exactly one. */
export function single(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A ticket id is a UUID: anything else in the URL never reaches the API. */
export function isUuid(value: string): boolean {
  return UUID.test(value);
}

export function listHref(filter: TicketFilter, cursor?: string | null): string {
  const query = new URLSearchParams();
  if (filter !== "open") query.set("status", filter);
  if (cursor) query.set("cursor", cursor);
  const text = query.toString();
  return text ? `${SUPPORT_PATH}?${text}` : SUPPORT_PATH;
}

export function ticketHref(ticketId: string): string {
  return `${SUPPORT_PATH}/${ticketId}`;
}
