import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Card, CardDescription } from "@/components/ui/card";
import { toLocale } from "@/i18n/locale";
import { getT } from "@/i18n/server";
import { apiGet } from "@/lib/api";
import { requireStaff, staffAuth } from "@/lib/session";
import { cn } from "@/lib/utils";

import { LocalTime } from "../local-time";
import { StatusBadge } from "./status-badge";
import {
  listHref,
  single,
  TICKET_FILTERS,
  ticketHref,
  type TicketFilter,
  type TicketItem,
  toFilter,
} from "./tickets";

type TicketPage = { items: TicketItem[]; next_cursor: string | null };

// One row: who, what about, when, status. Stacked on a phone, columns from md up; the header
// row uses the same columns.
const COLUMNS =
  "md:grid md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1.3fr)_8rem] md:items-center md:gap-4";
const PILL_LINK =
  "inline-flex h-9 items-center rounded-pill bg-white px-4 text-sm font-semibold text-navy-900 shadow-sm outline-none hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-green-700 focus-visible:ring-offset-2";

/** One page of the list, or null when the API cannot be read (shown as the error state). */
async function loadTickets(
  auth: RequestInit,
  filter: TicketFilter,
  cursor: string | undefined,
): Promise<TicketPage | null> {
  try {
    return await apiGet("/v1/admin/support/tickets", {
      ...auth,
      query: { status: filter === "all" ? undefined : filter, cursor },
    });
  } catch {
    return null;
  }
}

/**
 * The support tickets people sent from the app ("Talk to Jack", #274): open ones first in
 * line, newest first, with a filter by status. The message itself is on the ticket's page.
 */
export default async function SupportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Cached per request: the layout already asked the API who this is.
  const user = await requireStaff();
  const locale = toLocale(user.locale);
  const t = await getT(locale);
  const query = await searchParams;
  const filter = toFilter(query.status);
  const cursor = single(query.cursor);
  const page = await loadTickets(await staffAuth(), filter, cursor);

  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold text-navy-900">{t("admin.support.title")}</h1>
        <p className="text-sm text-gray-500">{t("admin.support.subtitle")}</p>
      </div>
      <nav aria-label={t("admin.support.filter.label")} className="flex flex-wrap gap-2">
        {TICKET_FILTERS.map((value) => (
          <Link
            key={value}
            href={listHref(value)}
            aria-current={value === filter ? "true" : undefined}
            className={cn(
              "inline-flex h-9 items-center rounded-pill px-4 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-green-700 focus-visible:ring-offset-2",
              value === filter
                ? "bg-navy-900 text-white"
                : "bg-white text-navy-900 shadow-sm hover:bg-gray-50",
            )}
          >
            {t(`admin.support.filter.${value}`)}
          </Link>
        ))}
      </nav>
      {page === null ? (
        <Card role="alert" className="flex flex-col items-start gap-4">
          <p className="font-semibold text-danger">{t("admin.support.loadError")}</p>
          <Link href={listHref(filter)} className={PILL_LINK}>
            {t("admin.support.retry")}
          </Link>
        </Card>
      ) : page.items.length === 0 ? (
        <Card className="flex flex-col items-start gap-4">
          {/* Past the last page (the older tickets changed status meanwhile): not "none". */}
          <CardDescription>
            {cursor ? t("admin.support.noOlder") : t(`admin.support.empty.${filter}`)}
          </CardDescription>
          {cursor ? (
            <Link href={listHref(filter)} className={PILL_LINK}>
              {t("admin.support.newest")}
            </Link>
          ) : null}
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          <div
            aria-hidden
            className={cn("hidden px-6 text-xs font-semibold text-gray-500 uppercase", COLUMNS)}
          >
            <span>{t("admin.support.columns.from")}</span>
            <span>{t("admin.support.columns.topic")}</span>
            <span>{t("admin.support.columns.sent")}</span>
            <span>{t("admin.support.columns.status")}</span>
          </div>
          <ul className="flex flex-col gap-3">
            {page.items.map((ticket) => (
              <li key={ticket.id}>
                <Link
                  href={ticketHref(ticket.id)}
                  className={cn(
                    "flex flex-col gap-2 rounded-lg bg-white px-4 py-4 text-navy-900 shadow-[0_8px_24px_rgb(1_23_46/0.08)] outline-none hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-green-700 md:px-6",
                    COLUMNS,
                  )}
                >
                  <span className="flex items-center justify-between gap-3 md:contents">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate font-semibold">
                        {ticket.user_first_name ?? t("admin.support.noName")}
                      </span>
                      <Badge variant="muted" className="shrink-0">
                        {t(`admin.support.role.${ticket.role}`)}
                      </Badge>
                    </span>
                    <span className="shrink-0 md:order-last">
                      <StatusBadge status={ticket.status}>
                        {t(`admin.support.status.${ticket.status}`)}
                      </StatusBadge>
                    </span>
                  </span>
                  <span className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
                    <span>{t(`admin.support.topic.${ticket.topic}`)}</span>
                    {ticket.job_id ? (
                      <Badge variant="muted">{t("admin.support.aboutJob")}</Badge>
                    ) : null}
                  </span>
                  <span className="text-sm text-gray-500">
                    <LocalTime iso={ticket.created_at} locale={locale} />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          {cursor || page.next_cursor ? (
            <div className="flex flex-wrap gap-3 pt-2">
              {cursor ? (
                <Link href={listHref(filter)} className={PILL_LINK}>
                  {t("admin.support.newest")}
                </Link>
              ) : null}
              {page.next_cursor ? (
                <Link href={listHref(filter, page.next_cursor)} className={PILL_LINK}>
                  {t("admin.support.older")}
                </Link>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
