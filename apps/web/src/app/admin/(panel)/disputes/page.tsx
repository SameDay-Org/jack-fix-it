import Link from "next/link";

import { Card, CardDescription } from "@/components/ui/card";
import { toLocale } from "@/i18n/locale";
import { getT } from "@/i18n/server";
import { apiGet } from "@/lib/api";
import { requireStaff, staffAuth } from "@/lib/session";
import { cn } from "@/lib/utils";

import { LocalTime } from "../local-time";
import { AgeTimer, type AgeTimerText } from "./age-timer";
import { disputeAgeLimits } from "./config";
import {
  DISPUTE_FILTERS,
  disputeHref,
  type DisputeItem,
  type DisputeStatus,
  formatMoney,
  listHref,
  toFilter,
} from "./disputes";
import { RefundFailedChip, StatusBadge } from "./status-badge";

const PILL_LINK =
  "inline-flex h-9 items-center rounded-pill bg-white px-4 text-sm font-semibold text-navy-900 shadow-sm outline-none hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-green-700 focus-visible:ring-offset-2";
const ROW_LINK =
  "font-mono font-semibold text-navy-900 underline-offset-2 outline-none hover:underline focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-green-700";

/** The list, oldest first, or null when the API cannot be read (shown as the error state). */
async function loadDisputes(
  auth: RequestInit,
  filter: DisputeStatus,
): Promise<DisputeItem[] | null> {
  try {
    const page = await apiGet("/v1/admin/disputes", { ...auth, query: { status: filter } });
    return page.disputes;
  } catch {
    return null;
  }
}

type T = Awaited<ReturnType<typeof getT>>;

/**
 * The disputes customers opened on finished jobs (#83), for agents and admins: open ones by
 * default, the longest waiting on top, with how long each has waited (amber, then red), or the
 * resolved ones. A dense table on a wide screen, one card per dispute on a phone. The text and
 * the photos are on the dispute's page, whose every read the API records.
 */
export default async function DisputesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Cached per request: the layout already asked the API who this is.
  const user = await requireStaff();
  const locale = toLocale(user.locale);
  const t = await getT(locale);
  const filter = toFilter((await searchParams).status);
  const disputes = await loadDisputes(await staffAuth(), filter);
  const serverNow = new Date().toISOString();
  const limits = disputeAgeLimits();
  const ageText: AgeTimerText = {
    minutes: t("admin.disputes.age.minutes"),
    hours: t("admin.disputes.age.hours"),
    days: t("admin.disputes.age.days"),
    warn: t("admin.disputes.age.warn"),
    late: t("admin.disputes.age.late"),
  };
  const cells = (dispute: DisputeItem) => rowCells(dispute, t, locale);
  const age = (dispute: DisputeItem) =>
    dispute.status === "open" ? (
      <AgeTimer openedAt={dispute.opened_at} serverNow={serverNow} limits={limits} text={ageText} />
    ) : (
      <span className="text-sm text-gray-500">
        <LocalTime iso={dispute.resolved_at ?? dispute.opened_at} locale={locale} />
      </span>
    );

  return (
    <div className="flex max-w-6xl flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold text-navy-900">{t("admin.disputes.title")}</h1>
        <p className="text-sm text-gray-500">{t("admin.disputes.subtitle")}</p>
      </div>
      <nav aria-label={t("admin.disputes.filter.label")} className="flex flex-wrap gap-2">
        {DISPUTE_FILTERS.map((value) => (
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
            {t(`admin.disputes.filter.${value}`)}
          </Link>
        ))}
      </nav>
      {disputes === null ? (
        <Card role="alert" className="flex flex-col items-start gap-4">
          <p className="font-semibold text-danger">{t("admin.disputes.loadError")}</p>
          <Link href={listHref(filter)} className={PILL_LINK}>
            {t("admin.disputes.retry")}
          </Link>
        </Card>
      ) : disputes.length === 0 ? (
        <Card>
          <CardDescription>{t(`admin.disputes.empty.${filter}`)}</CardDescription>
        </Card>
      ) : (
        <>
          {/* Wide screens: one dense table. */}
          <div className="hidden overflow-hidden rounded-lg bg-white shadow-[0_8px_24px_rgb(1_23_46/0.08)] lg:block">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">
                {t("admin.disputes.title")}: {t(`admin.disputes.filter.${filter}`)}
              </caption>
              <thead className="bg-gray-50 text-xs font-semibold text-gray-500 uppercase">
                <tr>
                  <th scope="col" className="px-4 py-3">
                    {t("admin.disputes.columns.request")}
                  </th>
                  <th scope="col" className="px-4 py-3">
                    {t("admin.disputes.columns.reason")}
                  </th>
                  <th scope="col" className="px-4 py-3">
                    {t("admin.disputes.columns.parties")}
                  </th>
                  <th scope="col" className="px-4 py-3 text-right">
                    {t("admin.disputes.columns.money")}
                  </th>
                  <th scope="col" className="px-4 py-3">
                    {t("admin.disputes.columns.age")}
                  </th>
                  <th scope="col" className="px-4 py-3">
                    {t("admin.disputes.columns.status")}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {disputes.map((dispute) => {
                  const cell = cells(dispute);
                  return (
                    <tr key={dispute.id} className="align-middle">
                      <th scope="row" className="px-4 py-3 font-normal whitespace-nowrap">
                        <Link href={disputeHref(dispute.id)} className={ROW_LINK}>
                          {dispute.public_code}
                        </Link>
                      </th>
                      <td className="px-4 py-3">{cell.reason}</td>
                      <td className="px-4 py-3">{cell.parties}</td>
                      <td className="px-4 py-3 text-right whitespace-nowrap tabular-nums">
                        {cell.money}
                      </td>
                      <td className="px-4 py-3">{age(dispute)}</td>
                      <td className="px-4 py-3">{cell.status}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {/* Phones and tablets: one card per dispute. */}
          <ul className="flex flex-col gap-3 lg:hidden">
            {disputes.map((dispute) => {
              const cell = cells(dispute);
              return (
                <li key={dispute.id}>
                  <Card className="flex flex-col gap-3 px-4 py-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <Link href={disputeHref(dispute.id)} className={ROW_LINK}>
                        {dispute.public_code}
                      </Link>
                      {cell.status}
                    </div>
                    <p className="text-sm">{cell.reason}</p>
                    <p className="text-sm">{cell.parties}</p>
                    <p className="text-sm tabular-nums">
                      {/* The table's column header, which a card has not. */}
                      <span className="text-gray-500">{t("admin.disputes.columns.money")}: </span>
                      {cell.money}
                    </p>
                    <div>{age(dispute)}</div>
                  </Card>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}

/** The cells a row and a card share. */
function rowCells(dispute: DisputeItem, t: T, locale: string) {
  const total =
    dispute.customer_total_cents === null
      ? t("admin.disputes.notOnRecord")
      : formatMoney(dispute.customer_total_cents, dispute.currency, locale);
  return {
    reason: t(`admin.disputes.reason.${dispute.reason_code}`),
    parties: (
      <span className="break-words">
        {dispute.customer_deleted
          ? t("admin.deletedUser")
          : (dispute.customer_first_name ?? t("admin.disputes.noName"))}
        <span className="text-gray-500"> · </span>
        {dispute.pro_deleted
          ? t("admin.deletedUser")
          : (dispute.pro_first_name ?? t("admin.disputes.noName"))}
      </span>
    ),
    money: `${total} / ${formatMoney(dispute.pro_payout_cents, dispute.currency, locale)}`,
    status: (
      <span className="flex flex-wrap items-center gap-2">
        <StatusBadge status={dispute.status}>
          {dispute.resolution
            ? t(`admin.disputes.resolution.${dispute.resolution}`)
            : t(`admin.disputes.status.${dispute.status}`)}
        </StatusBadge>
        {dispute.refund_failed ? (
          <RefundFailedChip>{t("admin.disputes.refundFailed")}</RefundFailedChip>
        ) : null}
      </span>
    ),
  };
}
