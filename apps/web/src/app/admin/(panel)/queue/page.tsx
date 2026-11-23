import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { toLocale } from "@/i18n/locale";
import { getT } from "@/i18n/server";
import { apiGet } from "@/lib/api";
import { requireStaff, staffAuth } from "@/lib/session";
import { cn } from "@/lib/utils";

import { LocalTime } from "../local-time";
import { AutoRefresh } from "./auto-refresh";
import { ContactTimer } from "./contact-timer";
import {
  ageOf,
  apiQuery,
  ASSIGNED,
  awaitsFirstContact,
  BUCKET_TABS,
  type Category,
  categoryName,
  QUEUE_PATH,
  QUEUE_TABS,
  queueHref,
  type QueuePage,
  queueRefreshMs,
  type QueueSummary,
  type QueueTab,
  REQUEST_STATUSES,
  requestHref,
  toFilters,
  toTab,
} from "./queue";
import { StatusBadge } from "./status-badge";

// One row: the request, what and where, its status, the first-contact timer, who holds it,
// its age. A dense table from lg up (the same columns in the header row), cards below.
const COLUMNS =
  "lg:grid lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1.3fr)_minmax(0,1.1fr)_9rem_minmax(0,0.9fr)_4.5rem] lg:items-center lg:gap-4";
const PILL_LINK =
  "inline-flex h-9 items-center rounded-pill bg-white px-4 text-sm font-semibold text-navy-900 shadow-sm outline-none hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-green-700 focus-visible:ring-offset-2";
const SELECT =
  "h-11 w-full rounded-pill border border-gray-500/30 bg-white px-4 text-base text-navy-900 outline-none focus-visible:border-green-700 focus-visible:ring-2 focus-visible:ring-green-700/30";

/** `load`'s answer, or null when the API cannot be read. */
async function attempt<T>(load: () => Promise<T>): Promise<T | null> {
  try {
    return await load();
  } catch {
    return null;
  }
}

/**
 * The BDC's operations queue (D16.2, #81): the requests by bucket, each tab with its count,
 * the first-contact timer running on the ones nobody has contacted yet, filters and a search
 * by request code. It reads itself again every half minute. No contact detail is here: the
 * phone, the email and the address are on the request's card.
 */
export default async function QueuePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Cached per request: the layout already asked the API who this is.
  const user = await requireStaff();
  const locale = toLocale(user.locale);
  const t = await getT(locale);
  const query = await searchParams;
  const tab = toTab(query.tab);
  const filters = toFilters(query);
  const cursor = typeof query.cursor === "string" && query.cursor ? query.cursor : undefined;
  const auth = await staffAuth();
  const [page, summary, categories] = await Promise.all([
    attempt<QueuePage>(() =>
      apiGet("/v1/admin/requests", { ...auth, query: apiQuery(tab, filters, cursor) }),
    ),
    attempt<QueueSummary>(() => apiGet("/v1/admin/requests/summary", auth)),
    attempt<Category[]>(() => apiGet("/v1/categories", { cache: "no-store" })),
  ]);
  const now = new Date();
  const filtered = Object.values(filters).some(Boolean);
  const timerText = { left: t("admin.queue.timer.left"), late: t("admin.queue.timer.late") };

  return (
    <div className="flex max-w-6xl flex-col gap-6">
      <AutoRefresh everyMs={queueRefreshMs()} />
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold text-navy-900">{t("admin.queue.title")}</h1>
        <p className="text-sm text-gray-500">{t("admin.queue.subtitle")}</p>
      </div>
      <nav aria-label={t("admin.queue.tabsLabel")} className="flex flex-wrap gap-2">
        {QUEUE_TABS.map((value) => {
          const count = bucketCount(summary, value);
          return (
            <Link
              key={value}
              href={queueHref(value, filters)}
              aria-current={value === tab ? "true" : undefined}
              className={cn(
                "inline-flex h-9 items-center gap-2 rounded-pill px-4 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-green-700 focus-visible:ring-offset-2",
                value === tab
                  ? "bg-navy-900 text-white"
                  : "bg-white text-navy-900 shadow-sm hover:bg-gray-50",
              )}
            >
              {t(`admin.queue.tabs.${value}`)}
              {count === null ? null : (
                <span
                  className={cn(
                    "rounded-pill px-2 text-xs",
                    value === tab ? "bg-navy-700" : "bg-gray-50",
                  )}
                >
                  {count}
                </span>
              )}
            </Link>
          );
        })}
      </nav>
      <form
        method="get"
        action={QUEUE_PATH}
        aria-label={t("admin.queue.filters.label")}
        className="grid grid-cols-2 gap-3 rounded-lg bg-white p-4 shadow-[0_8px_24px_rgb(1_23_46/0.08)] lg:grid-cols-[repeat(5,minmax(0,1fr))_auto] lg:items-end"
      >
        {tab === "new" ? null : <input type="hidden" name="tab" value={tab} />}
        <div className="col-span-2 flex flex-col gap-1 lg:col-span-1">
          <Label htmlFor="queue-q">{t("admin.queue.filters.search")}</Label>
          <Input
            id="queue-q"
            name="q"
            defaultValue={filters.q ?? ""}
            placeholder={t("admin.queue.filters.searchPlaceholder")}
            maxLength={16}
            pattern="[A-Za-z0-9\-]{1,16}"
            autoComplete="off"
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="queue-status">{t("admin.queue.filters.status")}</Label>
          <select
            id="queue-status"
            name="status"
            defaultValue={filters.status ?? ""}
            className={SELECT}
          >
            <option value="">{t("admin.queue.filters.any")}</option>
            {REQUEST_STATUSES.map((status) => (
              <option key={status} value={status}>
                {t(`admin.queue.status.${status}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="queue-category">{t("admin.queue.filters.category")}</Label>
          <select
            id="queue-category"
            name="category_id"
            defaultValue={filters.categoryId ?? ""}
            className={SELECT}
          >
            <option value="">{t("admin.queue.filters.any")}</option>
            {(categories ?? []).map((category) => (
              <option key={category.id} value={category.id}>
                {categoryName(category, locale)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="queue-zip">{t("admin.queue.filters.zip")}</Label>
          <Input
            id="queue-zip"
            name="zip"
            defaultValue={filters.zip ?? ""}
            inputMode="numeric"
            maxLength={5}
            pattern="[0-9]{5}"
            autoComplete="off"
          />
        </div>
        {tab === "mine" ? (
          <div aria-hidden className="hidden lg:block" />
        ) : (
          <div className="flex flex-col gap-1">
            <Label htmlFor="queue-assigned">{t("admin.queue.filters.assigned")}</Label>
            <select
              id="queue-assigned"
              name="assigned"
              defaultValue={filters.assigned ?? "any"}
              className={SELECT}
            >
              {ASSIGNED.map((value) => (
                <option key={value} value={value}>
                  {t(`admin.queue.filters.assignedTo.${value}`)}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="col-span-2 flex flex-wrap items-center gap-2 lg:col-span-1">
          <Button type="submit" size="sm" className="h-11">
            {t("admin.queue.filters.apply")}
          </Button>
          {filtered ? (
            <Link href={queueHref(tab)} className={cn(PILL_LINK, "h-11")}>
              {t("admin.queue.filters.clear")}
            </Link>
          ) : null}
        </div>
      </form>
      {page === null ? (
        <Card role="alert" className="flex flex-col items-start gap-4">
          <p className="font-semibold text-danger">{t("admin.queue.loadError")}</p>
          <Link href={queueHref(tab, filters)} className={PILL_LINK}>
            {t("admin.queue.retry")}
          </Link>
        </Card>
      ) : page.items.length === 0 ? (
        <Card className="flex flex-col items-start gap-4">
          {/* Past the last page, or filtered down to nothing: not "the bucket is empty". */}
          <CardDescription>
            {cursor
              ? t("admin.queue.noMore")
              : filtered
                ? t("admin.queue.noMatch")
                : t(`admin.queue.empty.${tab}`)}
          </CardDescription>
          {cursor ? (
            <Link href={queueHref(tab, filters)} className={PILL_LINK}>
              {t("admin.queue.first")}
            </Link>
          ) : null}
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          <div
            aria-hidden
            className={cn("hidden px-5 text-xs font-semibold text-gray-500 uppercase", COLUMNS)}
          >
            <span>{t("admin.queue.columns.request")}</span>
            <span>{t("admin.queue.columns.category")}</span>
            <span>{t("admin.queue.columns.status")}</span>
            <span>{t("admin.queue.columns.firstContact")}</span>
            <span>{t("admin.queue.columns.agent")}</span>
            <span>{t("admin.queue.columns.age")}</span>
          </div>
          <ul className="flex flex-col gap-2">
            {page.items.map((item) => {
              const age = ageOf(item.created_at, now.getTime());
              return (
                <li key={item.id}>
                  <Link
                    href={requestHref(item.id)}
                    className={cn(
                      "flex flex-col gap-2 rounded-lg bg-white px-4 py-3 text-navy-900 shadow-[0_8px_24px_rgb(1_23_46/0.08)] outline-none hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-green-700 lg:px-5",
                      COLUMNS,
                    )}
                  >
                    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="font-semibold">{item.public_code}</span>
                      <span className="truncate text-sm">
                        {item.customer_deleted
                          ? t("admin.deletedUser")
                          : (item.customer_name ?? t("admin.queue.noName"))}
                      </span>
                      {item.urgency ? (
                        <Badge variant="warning">{t("admin.queue.urgent")}</Badge>
                      ) : null}
                    </span>
                    <span className="min-w-0 text-sm break-words">
                      {item.category
                        ? categoryName(item.category, locale)
                        : t("admin.queue.unclassified")}
                      <span className="text-gray-500"> · {item.zip_code}</span>
                    </span>
                    <span className="flex flex-wrap items-center gap-1">
                      <StatusBadge status={item.status}>
                        {t(`admin.queue.status.${item.status}`)}
                      </StatusBadge>
                      {/* Where every bucket is mixed, each row says which one it is in. */}
                      {(tab === "all" || tab === "mine") && item.bucket !== "other" ? (
                        <Badge variant="muted">{t(`admin.queue.tabs.${item.bucket}`)}</Badge>
                      ) : null}
                    </span>
                    <span className="text-sm">
                      {awaitsFirstContact(item) ? (
                        <ContactTimer
                          createdAt={item.created_at}
                          dueAt={item.first_contact_due_at}
                          serverNow={now.toISOString()}
                          text={timerText}
                        />
                      ) : item.first_contact_at ? (
                        <span className="text-gray-500">
                          {t("admin.queue.timer.contacted")}{" "}
                          <LocalTime iso={item.first_contact_at} locale={locale} />
                        </span>
                      ) : (
                        <span className="text-gray-500">
                          <span className="lg:hidden">
                            {t("admin.queue.columns.firstContact")}:{" "}
                          </span>
                          {t("admin.queue.timer.none")}
                        </span>
                      )}
                    </span>
                    {/* One line on a phone (who holds it, how old it is); two columns from lg. */}
                    <span className="flex items-center justify-between gap-4 lg:contents">
                      <span className="min-w-0 truncate text-sm">
                        <span className="text-gray-500 lg:hidden">
                          {t("admin.queue.columns.agent")}:{" "}
                        </span>
                        {item.assigned_agent ? (
                          (item.assigned_agent.name ?? t("admin.queue.agentNoName"))
                        ) : (
                          <span className="text-gray-500">{t("admin.queue.unassigned")}</span>
                        )}
                      </span>
                      <span className="shrink-0 text-sm text-gray-500">
                        {t(`admin.queue.age.${age.unit}`, { count: age.count })}
                      </span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
          {cursor || page.next_cursor ? (
            <div className="flex flex-wrap gap-3 pt-2">
              {cursor ? (
                <Link href={queueHref(tab, filters)} className={PILL_LINK}>
                  {t("admin.queue.first")}
                </Link>
              ) : null}
              {page.next_cursor ? (
                <Link href={queueHref(tab, filters, page.next_cursor)} className={PILL_LINK}>
                  {t("admin.queue.more")}
                </Link>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

/** A tab's count from the summary; "mine" has none, and none shows without an answer. */
function bucketCount(summary: QueueSummary | null, tab: QueueTab): number | null {
  if (summary === null || tab === "mine") return null;
  const bucket = BUCKET_TABS.find((value) => value === tab);
  return bucket ? summary[bucket] : summary.all;
}
