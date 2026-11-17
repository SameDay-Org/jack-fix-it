import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Card, CardDescription } from "@/components/ui/card";
import { toLocale } from "@/i18n/locale";
import { getT } from "@/i18n/server";
import { apiGet } from "@/lib/api";
import { requireStaff, staffAuth } from "@/lib/session";
import { cn } from "@/lib/utils";

import { LocalTime } from "../local-time";
import { single } from "../support/tickets";
import {
  categoryName,
  listHref,
  PRO_STATUSES,
  proHref,
  type ProPage,
  type ProStatus,
  toStatus,
} from "./pros";

// One row: who, what they do, where, their documents, since when they wait. Stacked on a
// phone, columns from md up; the header row uses the same columns.
const COLUMNS =
  "md:grid md:grid-cols-[minmax(0,1.2fr)_minmax(0,1.4fr)_5rem_minmax(0,1.5fr)_minmax(0,1.2fr)] md:items-center md:gap-4";
const PILL_LINK =
  "inline-flex h-9 items-center rounded-pill bg-white px-4 text-sm font-semibold text-navy-900 shadow-sm outline-none hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-green-700 focus-visible:ring-offset-2";

/** One page of the list, or null when the API cannot be read (shown as the error state). */
async function loadPros(
  auth: RequestInit,
  status: ProStatus,
  cursor: string | undefined,
): Promise<ProPage | null> {
  try {
    return await apiGet("/v1/admin/pros", { ...auth, query: { status, cursor } });
  } catch {
    return null;
  }
}

/**
 * The pros by verification status (D7.4, #41): the ones waiting for a decision first, newest
 * first. Only an approved pro receives requests, so this is where a pro starts working. The
 * list carries no contact detail; the documents are on the pro's page.
 */
export default async function ProsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Cached per request: the layout already asked the API who this is.
  const user = await requireStaff();
  const locale = toLocale(user.locale);
  const t = await getT(locale);
  const query = await searchParams;
  const status = toStatus(query.status);
  const cursor = single(query.cursor);
  const page = await loadPros(await staffAuth(), status, cursor);

  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold text-navy-900">{t("admin.pros.title")}</h1>
        <p className="text-sm text-gray-500">{t("admin.pros.subtitle")}</p>
      </div>
      <nav aria-label={t("admin.pros.filter.label")} className="flex flex-wrap gap-2">
        {PRO_STATUSES.map((value) => (
          <Link
            key={value}
            href={listHref(value)}
            aria-current={value === status ? "true" : undefined}
            className={cn(
              "inline-flex h-9 items-center gap-2 rounded-pill px-4 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-green-700 focus-visible:ring-offset-2",
              value === status
                ? "bg-navy-900 text-white"
                : "bg-white text-navy-900 shadow-sm hover:bg-gray-50",
            )}
          >
            {t(`admin.pros.status.${value}`)}
            {/* The API counts every pro of each status; without an answer, no number. */}
            {page ? (
              <span
                className={cn(
                  "rounded-pill px-2 text-xs",
                  value === status ? "bg-navy-700" : "bg-gray-50",
                )}
              >
                {page.counts[value]}
              </span>
            ) : null}
          </Link>
        ))}
      </nav>
      {page === null ? (
        <Card role="alert" className="flex flex-col items-start gap-4">
          <p className="font-semibold text-danger">{t("admin.pros.loadError")}</p>
          <Link href={listHref(status)} className={PILL_LINK}>
            {t("admin.pros.retry")}
          </Link>
        </Card>
      ) : page.items.length === 0 ? (
        <Card className="flex flex-col items-start gap-4">
          {/* Past the last page (the older pros changed status meanwhile): not "none". */}
          <CardDescription>
            {cursor ? t("admin.pros.noOlder") : t(`admin.pros.empty.${status}`)}
          </CardDescription>
          {cursor ? (
            <Link href={listHref(status)} className={PILL_LINK}>
              {t("admin.pros.newest")}
            </Link>
          ) : null}
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          <div
            aria-hidden
            className={cn("hidden px-6 text-xs font-semibold text-gray-500 uppercase", COLUMNS)}
          >
            <span>{t("admin.pros.columns.pro")}</span>
            <span>{t("admin.pros.columns.categories")}</span>
            <span>{t("admin.pros.columns.zips")}</span>
            <span>{t("admin.pros.columns.documents")}</span>
            <span>{t("admin.pros.columns.submitted")}</span>
          </div>
          <ul className="flex flex-col gap-3">
            {page.items.map((pro) => (
              <li key={pro.id}>
                <Link
                  href={proHref(pro.id)}
                  className={cn(
                    "flex flex-col gap-2 rounded-lg bg-white px-4 py-4 text-navy-900 shadow-[0_8px_24px_rgb(1_23_46/0.08)] outline-none hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-green-700 md:px-6",
                    COLUMNS,
                  )}
                >
                  <span className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="truncate font-semibold">
                      {pro.name ?? t("admin.pros.noName")}
                    </span>
                    {pro.payouts_enabled ? null : (
                      <Badge variant="muted" className="shrink-0">
                        {t("admin.pros.noPayouts")}
                      </Badge>
                    )}
                  </span>
                  <span className="min-w-0 text-sm break-words">
                    {pro.categories.length > 0
                      ? pro.categories.map((category) => categoryName(category, locale)).join(", ")
                      : t("admin.pros.noCategories")}
                  </span>
                  <span className="text-sm">
                    <span className="text-gray-500 md:hidden">
                      {t("admin.pros.columns.zips")}:{" "}
                    </span>
                    {pro.zip_count}
                  </span>
                  <span className="flex flex-wrap gap-1">
                    {(["pending", "approved", "rejected"] as const).map((kind) =>
                      pro.documents[kind] > 0 ? (
                        <Badge key={kind} variant={kind === "pending" ? "warning" : "muted"}>
                          {t(`admin.pros.documentCount.${kind}`, { count: pro.documents[kind] })}
                        </Badge>
                      ) : null,
                    )}
                    {pro.documents.pending + pro.documents.approved + pro.documents.rejected ===
                    0 ? (
                      <span className="text-sm text-gray-500">{t("admin.pros.noDocuments")}</span>
                    ) : null}
                  </span>
                  <span className="text-sm text-gray-500">
                    {pro.submitted_at ? (
                      <LocalTime iso={pro.submitted_at} locale={locale} />
                    ) : (
                      t("admin.pros.nothingPending")
                    )}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          {cursor || page.next_cursor ? (
            <div className="flex flex-wrap gap-3 pt-2">
              {cursor ? (
                <Link href={listHref(status)} className={PILL_LINK}>
                  {t("admin.pros.newest")}
                </Link>
              ) : null}
              {page.next_cursor ? (
                <Link href={listHref(status, page.next_cursor)} className={PILL_LINK}>
                  {t("admin.pros.older")}
                </Link>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
