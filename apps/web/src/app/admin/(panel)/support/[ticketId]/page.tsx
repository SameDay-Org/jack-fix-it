import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { Card, CardTitle } from "@/components/ui/card";
import { toLocale } from "@/i18n/locale";
import { getT } from "@/i18n/server";
import { ApiError, apiGet } from "@/lib/api";
import { requireStaff, staffAuth } from "@/lib/session";

import { LocalTime } from "../../local-time";
import { requestHref } from "../../queue/queue";
import { StatusBadge } from "../status-badge";
import { isUuid, SUPPORT_PATH, type Ticket } from "../tickets";
import { StatusControl } from "./status-control";

const REQUEST_LINK =
  "rounded-sm font-mono font-semibold text-navy-900 underline outline-none focus-visible:ring-2 focus-visible:ring-green-700 focus-visible:ring-offset-2";

/** The ticket, or why there is none to show. */
async function loadTicket(
  auth: RequestInit,
  ticketId: string,
): Promise<Ticket | "not_found" | "error"> {
  try {
    return await apiGet("/v1/admin/support/tickets/{ticket_id}", {
      ...auth,
      params: { ticket_id: ticketId },
    });
  } catch (failure) {
    return failure instanceof ApiError && failure.status === 404 ? "not_found" : "error";
  }
}

/**
 * One support ticket: who wrote it, about what, the message as they typed it, and the status
 * control. An id that is not a UUID never reaches the API.
 */
export default async function TicketPage({ params }: { params: Promise<{ ticketId: string }> }) {
  // Cached per request: the layout already asked the API who this is.
  const user = await requireStaff();
  const locale = toLocale(user.locale);
  const t = await getT(locale);
  const { ticketId } = await params;
  const ticket = isUuid(ticketId) ? await loadTicket(await staffAuth(), ticketId) : "not_found";
  // A ticket that does not exist answers 404, with its own heading (not-found.tsx, #494).
  if (ticket === "not_found") notFound();

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <Link
        href={SUPPORT_PATH}
        className="inline-flex items-center gap-2 self-start rounded-pill text-sm font-semibold text-navy-900 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-green-700 focus-visible:ring-offset-2"
      >
        <ArrowLeft aria-hidden className="size-4" />
        {t("admin.support.detail.back")}
      </Link>
      {ticket === "error" ? (
        <Card role="alert">
          <p className="font-semibold text-danger">{t("admin.support.detail.loadError")}</p>
        </Card>
      ) : (
        <>
          <Card className="flex flex-col gap-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h1 className="text-2xl font-bold">{t(`admin.support.topic.${ticket.topic}`)}</h1>
              <StatusBadge status={ticket.status}>
                {t(`admin.support.status.${ticket.status}`)}
              </StatusBadge>
            </div>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-3 text-sm">
              <dt className="text-gray-500">{t("admin.support.detail.from")}</dt>
              <dd className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="font-semibold break-words">
                  {ticket.user_deleted
                    ? t("admin.deletedUser")
                    : (ticket.user_first_name ?? t("admin.support.noName"))}
                </span>
                <Badge variant="muted">{t(`admin.support.role.${ticket.role}`)}</Badge>
              </dd>
              <dt className="text-gray-500">{t("admin.support.detail.sent")}</dt>
              <dd>
                <LocalTime iso={ticket.created_at} locale={locale} />
              </dd>
              {ticket.closed_at ? (
                <>
                  <dt className="text-gray-500">{t("admin.support.detail.closed")}</dt>
                  <dd>
                    <LocalTime iso={ticket.closed_at} locale={locale} />
                  </dd>
                </>
              ) : null}
              {/* The job by its request code, a link to the request's card (#503); nothing
                  when the API names none. Never the raw job id: staff cannot act on it. */}
              {ticket.job_request_id && ticket.job_request_code ? (
                <>
                  <dt className="text-gray-500">{t("admin.support.detail.job")}</dt>
                  <dd>
                    <Link href={requestHref(ticket.job_request_id)} className={REQUEST_LINK}>
                      {ticket.job_request_code}
                    </Link>
                  </dd>
                </>
              ) : null}
              {ticket.app_version || ticket.platform ? (
                <>
                  <dt className="text-gray-500">{t("admin.support.detail.app")}</dt>
                  <dd className="break-words">
                    {[
                      ticket.app_version,
                      ticket.platform ? t(`admin.support.platform.${ticket.platform}`) : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </dd>
                </>
              ) : null}
            </dl>
            <section aria-labelledby="ticket-message" className="flex flex-col gap-2">
              <h2 id="ticket-message" className="text-sm font-semibold text-gray-500">
                {t("admin.support.detail.message")}
              </h2>
              <p className="rounded-md bg-gray-50 p-4 break-words whitespace-pre-wrap">
                {ticket.message}
              </p>
            </section>
          </Card>
          <Card className="flex flex-col gap-4">
            <CardTitle>{t("admin.support.detail.statusLabel")}</CardTitle>
            <StatusControl
              ticketId={ticket.id}
              status={ticket.status}
              text={{
                label: t("admin.support.detail.statusLabel"),
                saving: t("admin.support.detail.saving"),
                saved: t("admin.support.detail.saved"),
                statuses: {
                  open: t("admin.support.status.open"),
                  in_progress: t("admin.support.status.in_progress"),
                  closed: t("admin.support.status.closed"),
                },
                errors: {
                  not_found: t("admin.support.detail.errors.not_found"),
                  forbidden: t("admin.support.detail.errors.forbidden"),
                  unavailable: t("admin.support.detail.errors.unavailable"),
                },
              }}
            />
          </Card>
        </>
      )}
    </div>
  );
}
