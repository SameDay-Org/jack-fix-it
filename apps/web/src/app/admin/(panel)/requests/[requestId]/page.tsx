import type { TFunction } from "i18next";
import { ArrowLeft, ExternalLink, Mail, MessageSquare, Phone } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { toLocale } from "@/i18n/locale";
import { getT } from "@/i18n/server";
import { ApiError, apiGet } from "@/lib/api";
import { requireStaff, staffAuth } from "@/lib/session";

import { LocalTime } from "../../local-time";
import { ContactTimer } from "../../queue/contact-timer";
import {
  awaitsFirstContact,
  categoryName,
  contactLinks,
  formatUsd,
  isUuid,
  QUEUE_PATH,
  type RequestCard,
  requestMediaHref,
} from "../../queue/queue";
import { StatusBadge } from "../../queue/status-badge";
import { claimRequest, releaseRequest } from "../actions";
import { ClaimControl } from "./claim-control";

const CONTACT_LINK =
  "inline-flex h-11 items-center gap-2 rounded-pill bg-green-500 px-5 text-sm font-semibold text-navy-900 outline-none hover:bg-green-700 hover:text-white focus-visible:ring-2 focus-visible:ring-green-700 focus-visible:ring-offset-2";
const FILE_LINK =
  "inline-flex items-center gap-1 self-start rounded-pill text-sm font-semibold text-navy-900 underline outline-none focus-visible:ring-2 focus-visible:ring-green-700 focus-visible:ring-offset-2";
const TERM = "text-gray-500";
const FACTS = "grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-3 text-sm";

/** The request, or why there is none to show. */
async function loadCard(
  auth: RequestInit,
  requestId: string,
): Promise<RequestCard | "not_found" | "error"> {
  try {
    return await apiGet("/v1/admin/requests/{request_id}", {
      ...auth,
      params: { request_id: requestId },
    });
  } catch (failure) {
    return failure instanceof ApiError && failure.status === 404 ? "not_found" : "error";
  }
}

/** What the customer sees for this request, in the panel's words. */
function customerStatus(t: TFunction, key: string): string {
  const labels: Record<string, string> = {
    "customerStatus.requestReceived": t("admin.requests.customerStatus.requestReceived"),
    "customerStatus.reviewing": t("admin.requests.customerStatus.reviewing"),
    "customerStatus.findingAPro": t("admin.requests.customerStatus.findingAPro"),
    "customerStatus.quoteReady": t("admin.requests.customerStatus.quoteReady"),
    "customerStatus.scheduled": t("admin.requests.customerStatus.scheduled"),
    "customerStatus.professionalOnTheWay": t("admin.requests.customerStatus.professionalOnTheWay"),
    "customerStatus.inProgress": t("admin.requests.customerStatus.inProgress"),
    "customerStatus.waitingForConfirmation": t(
      "admin.requests.customerStatus.waitingForConfirmation",
    ),
    "customerStatus.completed": t("admin.requests.customerStatus.completed"),
    "customerStatus.needsAttention": t("admin.requests.customerStatus.needsAttention"),
    "customerStatus.cancelled": t("admin.requests.customerStatus.cancelled"),
  };
  return labels[key] ?? key;
}

/** An intake answer as text: what the customer picked or typed, shown as it is stored. */
function answerText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(answerText).join(", ");
  return JSON.stringify(value);
}

/**
 * A request's card for the BDC (D16.2, #81): who to call and how (the `tel:`, `sms:` and
 * `mailto:` links are built here from the customer's phone and email), where, what was asked,
 * the media, the quotes, the job, and who holds the request. Reading this page is recorded by
 * the API, because it shows the customer's contacts. An id that is not a UUID never reaches
 * the API. Everything the customer or a pro wrote renders as plain text.
 */
export default async function RequestPage({ params }: { params: Promise<{ requestId: string }> }) {
  // Cached per request: the layout already asked the API who this is.
  const user = await requireStaff();
  const locale = toLocale(user.locale);
  const t = await getT(locale);
  const { requestId } = await params;
  const card = isUuid(requestId) ? await loadCard(await staffAuth(), requestId) : "not_found";
  // A request that does not exist answers 404, with its own heading (not-found.tsx, #494).
  if (card === "not_found") notFound();
  const now = new Date();

  if (card === "error") {
    return (
      <div className="flex max-w-3xl flex-col gap-6">
        <BackLink label={t("admin.requests.back")} />
        <Card role="alert">
          <p className="font-semibold text-danger">{t("admin.requests.loadError")}</p>
        </Card>
      </div>
    );
  }

  const links = contactLinks(card.customer);
  const name =
    [card.customer.first_name, card.customer.last_name].filter(Boolean).join(" ") ||
    t("admin.queue.noName");
  const holder = card.assigned_agent;
  const mine = holder?.id === user.id;
  const mayRelease = holder !== null && (mine || user.role === "admin");
  const answers = Object.entries(card.intake_answers);
  const claimText = {
    claim: t("admin.requests.assignment.claim"),
    release: t("admin.requests.assignment.release"),
    saving: t("admin.requests.assignment.saving"),
    saved: t("admin.requests.assignment.saved"),
    errors: {
      held: t("admin.requests.assignment.errors.held"),
      not_found: t("admin.requests.assignment.errors.not_found"),
      forbidden: t("admin.requests.assignment.errors.forbidden"),
      unavailable: t("admin.requests.assignment.errors.unavailable"),
    },
  };

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <BackLink label={t("admin.requests.back")} />
      <Card className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-bold">{card.public_code}</h1>
          <span className="flex flex-wrap items-center gap-2">
            {card.urgency ? <Badge variant="warning">{t("admin.queue.urgent")}</Badge> : null}
            {card.bucket === "other" ? null : (
              <Badge variant="muted">{t(`admin.queue.tabs.${card.bucket}`)}</Badge>
            )}
            <StatusBadge status={card.status}>{t(`admin.queue.status.${card.status}`)}</StatusBadge>
          </span>
        </div>
        <dl className={FACTS}>
          <dt className={TERM}>{t("admin.requests.category")}</dt>
          <dd>
            {card.category ? categoryName(card.category, locale) : t("admin.queue.unclassified")}
          </dd>
          <dt className={TERM}>{t("admin.requests.created")}</dt>
          <dd>
            <LocalTime iso={card.created_at} locale={locale} />
            <span className={`${TERM} block`}>{t(`admin.requests.origin.${card.origin}`)}</span>
          </dd>
          <dt className={TERM}>{t("admin.requests.firstContact")}</dt>
          <dd>
            {awaitsFirstContact(card) ? (
              <ContactTimer
                createdAt={card.created_at}
                dueAt={card.first_contact_due_at}
                serverNow={now.toISOString()}
                text={{ left: t("admin.queue.timer.left"), late: t("admin.queue.timer.late") }}
              />
            ) : card.first_contact_at ? (
              <LocalTime iso={card.first_contact_at} locale={locale} />
            ) : (
              t("admin.queue.timer.none")
            )}
          </dd>
          {card.last_contact_at ? (
            <>
              <dt className={TERM}>{t("admin.requests.lastContact")}</dt>
              <dd>
                <LocalTime iso={card.last_contact_at} locale={locale} />
              </dd>
            </>
          ) : null}
          <dt className={TERM}>{t("admin.requests.customerSees")}</dt>
          <dd>{customerStatus(t, card.customer_status)}</dd>
          {card.next_action ? (
            <>
              <dt className={TERM}>{t("admin.requests.nextAction")}</dt>
              <dd className="break-words whitespace-pre-wrap">{card.next_action}</dd>
            </>
          ) : null}
        </dl>
      </Card>

      <Card className="flex flex-col gap-4">
        <CardTitle>{t("admin.requests.customer.title")}</CardTitle>
        <dl className={FACTS}>
          <dt className={TERM}>{t("admin.requests.customer.name")}</dt>
          <dd className="font-semibold break-words">{name}</dd>
          <dt className={TERM}>{t("admin.requests.customer.phone")}</dt>
          <dd className="break-words">
            {card.customer.phone ?? t("admin.requests.customer.noPhone")}
          </dd>
          <dt className={TERM}>{t("admin.requests.customer.email")}</dt>
          <dd className="break-all">{card.customer.email}</dd>
          <dt className={TERM}>{t("admin.requests.customer.language")}</dt>
          <dd>{card.customer.language.toUpperCase()}</dd>
          <dt className={TERM}>{t("admin.requests.customer.address")}</dt>
          <dd className="break-words">
            {card.address.line1}
            {card.address.line2 ? `, ${card.address.line2}` : ""}
            <br />
            {card.address.city}, {card.address.state} {card.address.zip_code}
          </dd>
          {card.preferred_contact ? (
            <>
              <dt className={TERM}>{t("admin.requests.customer.prefers")}</dt>
              <dd className="break-words">{card.preferred_contact}</dd>
            </>
          ) : null}
        </dl>
        <div className="flex flex-wrap gap-2">
          {links.tel ? (
            <a href={links.tel} className={CONTACT_LINK}>
              <Phone aria-hidden className="size-4" />
              {t("admin.requests.customer.call")}
            </a>
          ) : null}
          {links.sms ? (
            <a href={links.sms} className={CONTACT_LINK}>
              <MessageSquare aria-hidden className="size-4" />
              {t("admin.requests.customer.text")}
            </a>
          ) : null}
          {links.mailto ? (
            <a href={links.mailto} className={CONTACT_LINK}>
              <Mail aria-hidden className="size-4" />
              {t("admin.requests.customer.sendEmail")}
            </a>
          ) : null}
        </div>
      </Card>

      <Card className="flex flex-col gap-4">
        <CardTitle>{t("admin.requests.assignment.title")}</CardTitle>
        <p className="text-sm">
          {holder === null
            ? t("admin.requests.assignment.nobody")
            : mine
              ? t("admin.requests.assignment.you")
              : t("admin.requests.assignment.heldBy", {
                  name: holder.name ?? t("admin.queue.agentNoName"),
                })}
        </p>
        {/* Always the same control in the same place, so its last outcome survives the card's
            refresh: a take that lost the race keeps its message once the button is gone. */}
        <ClaimControl
          action={(mayRelease ? releaseRequest : claimRequest).bind(null, card.id)}
          kind={holder === null ? "claim" : mayRelease ? "release" : null}
          text={claimText}
        />
      </Card>

      <Card className="flex flex-col gap-4">
        <CardTitle>{t("admin.requests.request.title")}</CardTitle>
        <p className="rounded-md bg-gray-50 p-4 break-words whitespace-pre-wrap">
          {card.description}
        </p>
        {answers.length > 0 || card.preferred_date ? (
          <dl className={FACTS}>
            {card.preferred_date ? (
              <>
                <dt className={TERM}>{t("admin.requests.request.preferred")}</dt>
                <dd>
                  {new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(
                    new Date(`${card.preferred_date}T00:00:00Z`),
                  )}
                  {card.preferred_period
                    ? ` · ${t(`admin.requests.request.period.${card.preferred_period}`)}`
                    : ""}
                </dd>
              </>
            ) : null}
            {answers.map(([question, answer]) => (
              <div key={question} className="contents">
                <dt className={`${TERM} break-words`}>{question}</dt>
                <dd className="break-words whitespace-pre-wrap">{answerText(answer)}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        <section aria-labelledby="request-media" className="flex flex-col gap-2">
          <h3 id="request-media" className="text-sm font-semibold text-gray-500">
            {t("admin.requests.request.media")}
          </h3>
          {card.media.length === 0 && card.media_pending === 0 ? (
            <CardDescription>{t("admin.requests.request.noMedia")}</CardDescription>
          ) : (
            <ul className="flex flex-col gap-2">
              {card.media.map((media, index) => (
                <li key={index}>
                  <a
                    href={requestMediaHref(requestId, index)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={FILE_LINK}
                  >
                    {t(`admin.requests.request.open.${media.kind}`, { number: index + 1 })}
                    <ExternalLink aria-hidden className="size-4" />
                  </a>
                </li>
              ))}
              {card.media_pending > 0 ? (
                <li className="text-sm text-gray-500">
                  {t("admin.requests.request.mediaPending", { count: card.media_pending })}
                </li>
              ) : null}
            </ul>
          )}
          {card.media.length > 0 ? (
            <CardDescription>{t("admin.requests.request.filesOpenInNewTab")}</CardDescription>
          ) : null}
        </section>
      </Card>

      <Card className="flex flex-col gap-4">
        <CardTitle>{t("admin.requests.quotes.title")}</CardTitle>
        {card.quotes.length === 0 ? (
          <CardDescription>{t("admin.requests.quotes.none")}</CardDescription>
        ) : (
          <ul className="flex flex-col gap-2">
            {card.quotes.map((quote) => (
              <li
                key={quote.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-gray-500/30 px-4 py-3 text-sm"
              >
                <span className="flex min-w-0 flex-col">
                  <span className="font-semibold break-words">
                    {quote.pro_name ?? t("admin.queue.noName")}
                  </span>
                  <span className="text-gray-500">
                    {t("admin.requests.quotes.starts")}{" "}
                    <LocalTime iso={quote.proposed_start_at} locale={locale} />
                  </span>
                </span>
                <span className="flex items-center gap-2">
                  <span className="font-semibold">{formatUsd(quote.amount_cents, locale)}</span>
                  <Badge variant={quote.status === "accepted" ? "onNavy" : "muted"}>
                    {t(`admin.requests.quotes.status.${quote.status}`)}
                  </Badge>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="flex flex-col gap-4">
        <CardTitle>{t("admin.requests.job.title")}</CardTitle>
        {card.job === null ? (
          <CardDescription>{t("admin.requests.job.none")}</CardDescription>
        ) : (
          <>
            <dl className={FACTS}>
              <dt className={TERM}>{t("admin.requests.job.status")}</dt>
              <dd>{t(`admin.requests.job.statuses.${card.job.status}`)}</dd>
              {card.job.scheduled_start_at ? (
                <>
                  <dt className={TERM}>{t("admin.requests.job.scheduled")}</dt>
                  <dd>
                    <LocalTime iso={card.job.scheduled_start_at} locale={locale} />
                  </dd>
                </>
              ) : null}
            </dl>
            <section aria-labelledby="job-history" className="flex flex-col gap-2">
              <h3 id="job-history" className="text-sm font-semibold text-gray-500">
                {t("admin.requests.job.history")}
              </h3>
              <ol className="flex flex-col gap-1 text-sm">
                {card.job.events.map((event, index) => (
                  <li key={index} className="flex flex-wrap gap-x-2">
                    <LocalTime iso={event.created_at} locale={locale} />
                    <span className="font-semibold">
                      {event.to_status
                        ? t(`admin.requests.job.statuses.${event.to_status}`)
                        : event.type}
                    </span>
                    {event.by_system ? (
                      <span className="text-gray-500">{t("admin.requests.job.bySystem")}</span>
                    ) : null}
                  </li>
                ))}
              </ol>
            </section>
          </>
        )}
      </Card>
    </div>
  );
}

function BackLink({ label }: { label: string }) {
  return (
    <Link
      href={QUEUE_PATH}
      className="inline-flex items-center gap-2 self-start rounded-pill text-sm font-semibold text-navy-900 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-green-700 focus-visible:ring-offset-2"
    >
      <ArrowLeft aria-hidden className="size-4" />
      {label}
    </Link>
  );
}
