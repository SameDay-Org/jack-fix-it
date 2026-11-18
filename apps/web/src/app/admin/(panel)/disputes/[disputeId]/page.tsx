import { AlertTriangle, ArrowLeft, Clock } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { Card, CardTitle } from "@/components/ui/card";
import { toLocale } from "@/i18n/locale";
import { getT } from "@/i18n/server";
import { ApiError, apiGet } from "@/lib/api";
import { requireStaff, staffAuth } from "@/lib/session";

import { LocalTime } from "../../local-time";
import { isUuid } from "../../support/tickets";
import { resolveDispute } from "../actions";
import { AgeTimer } from "../age-timer";
import { disputeAgeLimits } from "../config";
import {
  DECISIONS,
  type Dispute,
  DISPUTES_PATH,
  formatMoney,
  photoHref,
  refundState,
  RESOLVE_ERRORS,
} from "../disputes";
import { StatusBadge } from "../status-badge";
import { ResolveControl, type ResolveControlText } from "./resolve-control";

type T = Awaited<ReturnType<typeof getT>>;

const TERM = "text-gray-500";
const DL = "grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-3 text-sm";

/** The dispute, or why there is none to show. */
async function loadDispute(
  auth: RequestInit,
  disputeId: string,
): Promise<Dispute | "not_found" | "error"> {
  try {
    return await apiGet("/v1/admin/disputes/{dispute_id}", {
      ...auth,
      params: { dispute_id: disputeId },
    });
  } catch (failure) {
    return failure instanceof ApiError && failure.status === 404 ? "not_found" : "error";
  }
}

/**
 * One dispute (#83): the customer's report and the pro's reply side by side, as plain text;
 * the photos, through the panel's own route; the job's history; the money as the API froze it
 * and where the refund and the payout stand; the resolution once there is one. Admins resolve
 * it here; agents read it. Every read is recorded by the API. An id that is not a UUID never
 * reaches the API.
 */
export default async function DisputePage({ params }: { params: Promise<{ disputeId: string }> }) {
  // Cached per request: the layout already asked the API who this is.
  const user = await requireStaff();
  const locale = toLocale(user.locale);
  const t = await getT(locale);
  const { disputeId } = await params;
  const dispute = isUuid(disputeId) ? await loadDispute(await staffAuth(), disputeId) : "not_found";

  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <Link
        href={DISPUTES_PATH}
        className="inline-flex items-center gap-2 self-start rounded-pill text-sm font-semibold text-navy-900 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-green-700 focus-visible:ring-offset-2"
      >
        <ArrowLeft aria-hidden className="size-4" />
        {t("admin.disputes.detail.back")}
      </Link>
      {dispute === "not_found" ? (
        <Card>
          <h1 className="font-semibold">{t("admin.disputes.detail.notFound")}</h1>
        </Card>
      ) : dispute === "error" ? (
        <Card role="alert" className="flex flex-col items-start gap-4">
          <h1 className="font-semibold text-danger">{t("admin.disputes.detail.loadError")}</h1>
          <Link
            href={`${DISPUTES_PATH}/${disputeId}`}
            className="inline-flex h-9 items-center rounded-pill bg-white px-4 text-sm font-semibold text-navy-900 shadow-sm outline-none hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-green-700 focus-visible:ring-offset-2"
          >
            {t("admin.disputes.retry")}
          </Link>
        </Card>
      ) : (
        <DisputeView dispute={dispute} t={t} locale={locale} viewer={user} />
      )}
    </div>
  );
}

function DisputeView({
  dispute,
  t,
  locale,
  viewer,
}: {
  dispute: Dispute;
  t: T;
  locale: string;
  viewer: { id: string; role: string };
}) {
  const money = (cents: number) => formatMoney(cents, dispute.currency, locale);
  const refund = refundState(dispute.refund);

  return (
    <>
      <Card className="flex flex-col gap-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-bold">
            {t("admin.disputes.detail.title", { code: dispute.public_code })}
          </h1>
          <StatusBadge status={dispute.status}>
            {dispute.resolution
              ? t(`admin.disputes.resolution.${dispute.resolution}`)
              : t(`admin.disputes.status.${dispute.status}`)}
          </StatusBadge>
        </div>
        <dl className={DL}>
          <dt className={TERM}>{t("admin.disputes.detail.reason")}</dt>
          <dd className="font-semibold">{t(`admin.disputes.reason.${dispute.reason_code}`)}</dd>
          <dt className={TERM}>{t("admin.disputes.detail.opened")}</dt>
          <dd className="flex flex-wrap items-center gap-2">
            <LocalTime iso={dispute.opened_at} locale={locale} />
            {dispute.status === "open" ? (
              <AgeTimer
                openedAt={dispute.opened_at}
                serverNow={new Date().toISOString()}
                limits={disputeAgeLimits()}
                text={{
                  minutes: t("admin.disputes.age.minutes"),
                  hours: t("admin.disputes.age.hours"),
                  days: t("admin.disputes.age.days"),
                  warn: t("admin.disputes.age.warn"),
                  late: t("admin.disputes.age.late"),
                }}
              />
            ) : null}
          </dd>
          <dt className={TERM}>{t("admin.disputes.detail.job")}</dt>
          <dd>{t(`admin.requests.job.statuses.${dispute.job_status}`)}</dd>
          <dt className={TERM}>{t("admin.disputes.detail.customer")}</dt>
          <dd className="break-words">
            {dispute.customer_first_name ?? t("admin.disputes.noName")}
          </dd>
          <dt className={TERM}>{t("admin.disputes.detail.pro")}</dt>
          <dd className="break-words">{dispute.pro_first_name ?? t("admin.disputes.noName")}</dd>
        </dl>
      </Card>

      {refund && dispute.refund ? (
        <section
          aria-labelledby="refund-banner"
          data-refund={refund}
          className={
            refund === "failed"
              ? "flex gap-3 rounded-lg bg-danger p-4 text-white"
              : "flex gap-3 rounded-lg bg-warning p-4 text-navy-900"
          }
        >
          {refund === "failed" ? (
            <AlertTriangle aria-hidden className="mt-0.5 size-5 shrink-0" />
          ) : (
            <Clock aria-hidden className="mt-0.5 size-5 shrink-0" />
          )}
          <div className="flex flex-col gap-1">
            <h2 id="refund-banner" className="font-bold">
              {t(`admin.disputes.detail.banner.${refund}.title`)}
            </h2>
            <p className="text-sm">
              {t(`admin.disputes.detail.banner.${refund}.body`, {
                amount: money(dispute.refund.amount_cents),
              })}
            </p>
          </div>
        </section>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <TextCard id="customer-report" title={t("admin.disputes.detail.customerReport")}>
          {dispute.description}
        </TextCard>
        <TextCard id="pro-reply" title={t("admin.disputes.detail.proReply")}>
          {dispute.pro_reply ?? null}
          {dispute.pro_reply === null ? (
            <span className="text-gray-500">{t("admin.disputes.detail.noReply")}</span>
          ) : null}
          {dispute.pro_replied_at ? (
            <span className="mt-3 block text-xs text-gray-500">
              {t("admin.disputes.detail.replied")}{" "}
              <LocalTime iso={dispute.pro_replied_at} locale={locale} />
            </span>
          ) : null}
        </TextCard>
      </div>

      <Card className="flex flex-col gap-4">
        <CardTitle>{t("admin.disputes.detail.photos.title")}</CardTitle>
        {dispute.photos.length === 0 && dispute.photos_pending === 0 ? (
          <p className="text-sm text-gray-500">{t("admin.disputes.detail.photos.none")}</p>
        ) : null}
        {dispute.photos.length > 0 ? (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {dispute.photos.map((photo, index) => (
              <li key={photo.id}>
                <a
                  href={photoHref(dispute.id, photo.id)}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={t("admin.disputes.detail.photos.open", { n: index + 1 })}
                  className="block overflow-hidden rounded-md bg-gray-50 outline-none focus-visible:ring-2 focus-visible:ring-green-700 focus-visible:ring-offset-2"
                >
                  {/* Through the panel's route: the signed address stays on the server. */}
                  {/* eslint-disable-next-line @next/next/no-img-element -- a private, per-request image the optimizer must not fetch or cache */}
                  <img
                    src={photoHref(dispute.id, photo.id)}
                    alt={t("admin.disputes.detail.photos.alt", { n: index + 1 })}
                    loading="lazy"
                    decoding="async"
                    className="aspect-square w-full object-cover"
                  />
                </a>
              </li>
            ))}
          </ul>
        ) : null}
        {dispute.photos_pending > 0 ? (
          <p className="text-sm text-gray-500">
            {t("admin.disputes.detail.photos.pending", { count: dispute.photos_pending })}
          </p>
        ) : null}
      </Card>

      <Card className="flex flex-col gap-4">
        <CardTitle>{t("admin.disputes.detail.money.title")}</CardTitle>
        {dispute.payment ? null : (
          <p className="text-sm font-semibold">{t("admin.disputes.detail.money.noPayment")}</p>
        )}
        {/* One list, so every value starts on the same line. */}
        <dl className={DL}>
          {dispute.payment ? (
            <>
              <dt className={TERM}>{t("admin.disputes.detail.money.customerTotal")}</dt>
              <dd className="font-semibold tabular-nums">
                {money(dispute.payment.customer_total_cents)}
              </dd>
              <dt className={TERM}>{t("admin.disputes.detail.money.tax")}</dt>
              <dd className="tabular-nums">{money(dispute.payment.tax_cents)}</dd>
              <dt className={TERM}>{t("admin.disputes.detail.money.proPayout")}</dt>
              <dd className="tabular-nums">{money(dispute.payment.pro_payout_cents)}</dd>
              <dt className={TERM}>{t("admin.disputes.detail.money.platformFee")}</dt>
              <dd className="tabular-nums">{money(dispute.payment.platform_fee_cents)}</dd>
              <dt className={TERM}>{t("admin.disputes.detail.money.payment")}</dt>
              <dd>{t(`admin.disputes.detail.money.paymentStatus.${dispute.payment.status}`)}</dd>
            </>
          ) : null}
          <dt className={TERM}>{t("admin.disputes.detail.money.refund")}</dt>
          <dd>
            {dispute.refund ? (
              <span className="flex flex-col gap-1">
                <span>
                  <span className="font-semibold tabular-nums">
                    {money(dispute.refund.amount_cents)}
                  </span>
                  {" · "}
                  {t(`admin.disputes.detail.money.refundStatus.${dispute.refund.status}`)}
                </span>
                {dispute.refund.last_error_code ? (
                  <span className="text-xs text-gray-500">
                    {t("admin.disputes.detail.money.stripeCode", {
                      code: dispute.refund.last_error_code,
                    })}
                  </span>
                ) : null}
              </span>
            ) : (
              t("admin.disputes.detail.money.none")
            )}
          </dd>
          <dt className={TERM}>{t("admin.disputes.detail.money.transfer")}</dt>
          <dd>
            {dispute.transfer ? (
              <>
                <span className="font-semibold tabular-nums">
                  {money(dispute.transfer.amount_cents)}
                </span>
                {" · "}
                {t(`admin.disputes.detail.money.transferStatus.${dispute.transfer.status}`)}
              </>
            ) : (
              t("admin.disputes.detail.money.none")
            )}
          </dd>
        </dl>
      </Card>

      <Card className="flex flex-col gap-4">
        <CardTitle>{t("admin.disputes.detail.timeline.title")}</CardTitle>
        <ol className="flex flex-col gap-2 text-sm">
          {dispute.events.map((event, index) => (
            <li key={index} className="flex flex-wrap gap-x-2">
              <span className="text-gray-500">
                <LocalTime iso={event.created_at} locale={locale} />
              </span>
              <span className="font-semibold">
                {event.to_status ? t(`admin.requests.job.statuses.${event.to_status}`) : event.type}
              </span>
              {event.by_system ? (
                <span className="text-gray-500">
                  {t("admin.disputes.detail.timeline.bySystem")}
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      </Card>

      {dispute.status === "resolved" && dispute.resolution ? (
        <Card className="flex flex-col gap-4">
          <CardTitle>{t("admin.disputes.detail.resolution.title")}</CardTitle>
          <dl className={DL}>
            <dt className={TERM}>{t("admin.disputes.detail.resolution.decision")}</dt>
            <dd className="font-semibold">
              {t(`admin.disputes.resolution.${dispute.resolution}`)}
            </dd>
            {dispute.resolved_at ? (
              <>
                <dt className={TERM}>{t("admin.disputes.detail.resolution.resolvedAt")}</dt>
                <dd>
                  <LocalTime iso={dispute.resolved_at} locale={locale} />
                </dd>
              </>
            ) : null}
            {dispute.resolved_by ? (
              <>
                <dt className={TERM}>{t("admin.disputes.detail.resolution.resolvedBy")}</dt>
                <dd
                  className={dispute.resolved_by === viewer.id ? "" : "font-mono text-xs break-all"}
                >
                  {dispute.resolved_by === viewer.id
                    ? t("admin.disputes.detail.resolution.you")
                    : dispute.resolved_by}
                </dd>
              </>
            ) : null}
            {dispute.pro_release_cents !== null ? (
              <>
                <dt className={TERM}>{t("admin.disputes.detail.money.proRelease")}</dt>
                <dd className="tabular-nums">{money(dispute.pro_release_cents)}</dd>
              </>
            ) : null}
            {dispute.customer_refund_cents !== null ? (
              <>
                <dt className={TERM}>{t("admin.disputes.detail.money.customerRefund")}</dt>
                <dd className="tabular-nums">{money(dispute.customer_refund_cents)}</dd>
              </>
            ) : null}
          </dl>
          {dispute.resolution_note ? (
            <section aria-labelledby="resolution-note" className="flex flex-col gap-2">
              <h3 id="resolution-note" className="text-sm font-semibold text-gray-500">
                {t("admin.disputes.detail.resolution.note")}
              </h3>
              <p className="rounded-md bg-gray-50 p-4 break-words whitespace-pre-wrap">
                {dispute.resolution_note}
              </p>
            </section>
          ) : null}
        </Card>
      ) : null}

      {dispute.status === "open" ? (
        <Card className="flex flex-col gap-4">
          <CardTitle>{t("admin.disputes.resolve.title")}</CardTitle>
          {viewer.role === "admin" ? (
            <ResolveControl
              action={resolveDispute.bind(null, dispute.id)}
              code={dispute.public_code}
              payoutCents={dispute.pro_payout_cents}
              currency={dispute.currency}
              locale={locale}
              text={resolveText(dispute, t, money)}
            />
          ) : (
            <p className="text-sm font-semibold">{t("admin.disputes.detail.adminOnly")}</p>
          )}
        </Card>
      ) : null}
    </>
  );
}

/** A side's text as stored, never as HTML: React writes it as text. */
function TextCard({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <Card className="flex flex-col gap-3">
      <section aria-labelledby={id} className="flex flex-col gap-3">
        <h2 id={id} className="text-sm font-semibold text-gray-500">
          {title}
        </h2>
        <p className="break-words whitespace-pre-wrap">{children}</p>
      </section>
    </Card>
  );
}

/** The control's copy, with the dispute's own values written in. */
function resolveText(dispute: Dispute, t: T, money: (cents: number) => string): ResolveControlText {
  const payout = money(dispute.pro_payout_cents);
  const total =
    dispute.customer_total_cents === null
      ? t("admin.disputes.notOnRecord")
      : money(dispute.customer_total_cents);
  return {
    title: t("admin.disputes.resolve.title"),
    decisionLabel: t("admin.disputes.resolve.decisionLabel"),
    decisions: Object.fromEntries(
      DECISIONS.map((decision) => [
        decision,
        {
          label: t(`admin.disputes.resolve.decisions.${decision}.label`),
          hint: t(`admin.disputes.resolve.decisions.${decision}.hint`),
        },
      ]),
    ) as ResolveControlText["decisions"],
    decisionError: t("admin.disputes.resolve.decisionError"),
    amountLabel: t("admin.disputes.resolve.amountLabel"),
    amountHint: t("admin.disputes.resolve.amountHint", { payout }),
    amountErrors: {
      format: t("admin.disputes.resolve.amountErrors.format"),
      zero: t("admin.disputes.resolve.amountErrors.zero"),
      not_less: t("admin.disputes.resolve.amountErrors.not_less", { payout }),
    },
    noteLabel: t("admin.disputes.resolve.noteLabel"),
    noteHint: t("admin.disputes.resolve.noteHint"),
    noteError: t("admin.disputes.resolve.noteError"),
    review: t("admin.disputes.resolve.review"),
    confirmTitle: t("admin.disputes.resolve.confirmTitle"),
    totals: t("admin.disputes.resolve.totals", { total, payout }),
    sentences: {
      release: t("admin.disputes.resolve.sentences.release"),
      // `{{amount}}` stays for the control: it is what the admin types.
      partial: t("admin.disputes.resolve.sentences.partial", { amount: "{{amount}}" }),
      refund: t("admin.disputes.resolve.sentences.refund"),
    },
    codeLabel: t("admin.disputes.resolve.codeLabel", { code: dispute.public_code }),
    codeHint: t("admin.disputes.resolve.codeHint"),
    submit: t("admin.disputes.resolve.submit"),
    back: t("admin.disputes.resolve.back"),
    resolving: t("admin.disputes.resolve.resolving"),
    resolved: t("admin.disputes.resolve.resolved"),
    errors: Object.fromEntries(
      RESOLVE_ERRORS.map((key) => [key, t(`admin.disputes.resolve.errors.${key}`)]),
    ) as ResolveControlText["errors"],
  };
}
