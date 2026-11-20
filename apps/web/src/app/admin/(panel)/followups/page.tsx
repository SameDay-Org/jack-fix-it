import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Card, CardDescription } from "@/components/ui/card";
import { toLocale } from "@/i18n/locale";
import { getT } from "@/i18n/server";
import { ApiError, apiGet } from "@/lib/api";
import { requireStaff, staffAuth } from "@/lib/session";
import { cn } from "@/lib/utils";

import { businessTimeZone } from "../kpis/config";
import { LocalTime } from "../local-time";
import { requestHref } from "../queue/queue";
import { completeFollowup } from "../requests/actions";
import { dueTone, type StaffMember } from "../requests/ops";
import { followupMaxDays } from "../requests/ops-server";
import { FollowupDone, KeptDoneRefusal } from "../requests/[requestId]/ops-controls";
import { opsText } from "../requests/[requestId]/ops-sections";
import { FOLLOWUP_VIEWS, followupsHref, type FollowupsPage as Page, toQuery } from "./followups";

const PILL_LINK =
  "inline-flex h-9 items-center rounded-pill bg-white px-4 text-sm font-semibold text-navy-900 shadow-sm outline-none hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-green-700 focus-visible:ring-offset-2";
const FIELD =
  "h-9 rounded-pill border border-gray-500/30 bg-white px-4 text-sm text-navy-900 outline-none focus-visible:border-green-700 focus-visible:ring-2 focus-visible:ring-green-700/30";
const TONE = { overdue: "bg-danger text-white", today: "bg-warning text-navy-900" } as const;

/**
 * One page of follow-ups, a cursor the API refused (the list moved on), a list this account may
 * not read (403: the API decides by the account's current role, so an admin demoted since asks
 * for another's list in vain), or an error.
 */
async function loadPage(
  auth: RequestInit,
  query: ReturnType<typeof toQuery>,
): Promise<Page | "moved" | "forbidden" | "error"> {
  try {
    return await apiGet("/v1/admin/followups", {
      ...auth,
      query: { due: query.due, assignee: query.assignee, cursor: query.cursor },
    });
  } catch (failure) {
    if (failure instanceof ApiError && failure.status === 403) return "forbidden";
    return failure instanceof ApiError && failure.status === 422 && query.cursor
      ? "moved"
      : "error";
  }
}

async function loadStaff(auth: RequestInit): Promise<StaffMember[]> {
  try {
    return (await apiGet("/v1/admin/staff", auth)).staff;
  } catch {
    return [];
  }
}

/**
 * The follow-ups the BDC scheduled (#82): the reader's own, due by tonight in the business time
 * zone (overdue included, the most overdue first) or all open ones; an admin may read another
 * staff member's. Each names its request by code and status (a link to the card), what to do
 * and when; "Mark done" for its assignee or an admin. No contact anywhere: the API gives none.
 */
export default async function FollowupsPageView({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Cached per request: the layout already asked the API who this is.
  const user = await requireStaff();
  const locale = toLocale(user.locale);
  const t = await getT(locale);
  const isAdmin = user.role === "admin";
  const query = toQuery(await searchParams, isAdmin);
  const auth = await staffAuth();
  const [page, staff] = await Promise.all([
    loadPage(auth, query),
    isAdmin ? loadStaff(auth) : Promise.resolve([]),
  ]);
  const zone = businessTimeZone();
  const nowMs = new Date().getTime();
  const text = opsText(t, followupMaxDays());
  const first = { due: query.due, assignee: query.assignee };
  const offered =
    typeof page === "object"
      ? page.items.filter((item) => item.assigned_to.id === user.id || isAdmin).map(({ id }) => id)
      : [];

  return (
    <div className="flex max-w-6xl flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold text-navy-900">{t("admin.followups.title")}</h1>
        <p className="text-sm text-gray-500">{t("admin.followups.subtitle")}</p>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav aria-label={t("admin.followups.views.label")} className="flex flex-wrap gap-2">
          {FOLLOWUP_VIEWS.map((due) => (
            <Link
              key={due}
              href={followupsHref({ due, assignee: query.assignee })}
              aria-current={due === query.due ? "true" : undefined}
              className={cn(
                "inline-flex h-9 items-center rounded-pill px-4 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-green-700 focus-visible:ring-offset-2",
                due === query.due
                  ? "bg-navy-900 text-white"
                  : "bg-white text-navy-900 shadow-sm hover:bg-gray-50",
              )}
            >
              {t(`admin.followups.views.${due}`)}
            </Link>
          ))}
        </nav>
        {isAdmin && staff.length > 0 ? (
          // A plain GET form: it works without script and keeps the view.
          <form action="" method="get" className="flex flex-wrap items-center gap-2">
            {query.due === "today" ? null : <input type="hidden" name="due" value={query.due} />}
            <label htmlFor="followups-assignee" className="text-sm font-semibold">
              {t("admin.followups.assignee.label")}
            </label>
            <select
              id="followups-assignee"
              name="assignee"
              defaultValue={query.assignee ?? ""}
              className={FIELD}
            >
              <option value="">{t("admin.followups.assignee.mine")}</option>
              {staff
                .filter((member) => member.id !== user.id)
                .map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.first_name ?? t("admin.requests.ops.followups.noName")}
                  </option>
                ))}
            </select>
            <Button type="submit" size="sm" variant="secondary">
              {t("admin.followups.assignee.show")}
            </Button>
          </form>
        ) : null}
      </div>
      <KeptDoneRefusal offered={offered} text={text}>
        {page === "error" ? (
          <Card role="alert" className="flex flex-col items-start gap-4">
            <p className="font-semibold text-danger">{t("admin.followups.loadError")}</p>
            <Link href={followupsHref(query)} className={PILL_LINK}>
              {t("admin.followups.retry")}
            </Link>
          </Card>
        ) : page === "forbidden" ? (
          <Card role="alert" className="flex flex-col items-start gap-4">
            <p className="font-semibold text-danger">{t("admin.followups.forbidden")}</p>
            <Link href={followupsHref({ due: query.due })} className={PILL_LINK}>
              {t("admin.followups.own")}
            </Link>
          </Card>
        ) : page === "moved" ? (
          <Card className="flex flex-col items-start gap-4">
            <CardDescription>{t("admin.followups.moved")}</CardDescription>
            <Link href={followupsHref(first)} className={PILL_LINK}>
              {t("admin.followups.first")}
            </Link>
          </Card>
        ) : page.items.length === 0 ? (
          <Card className="flex flex-col items-start gap-4">
            <CardDescription>{t(`admin.followups.empty.${query.due}`)}</CardDescription>
            {query.cursor ? (
              <Link href={followupsHref(first)} className={PILL_LINK}>
                {t("admin.followups.first")}
              </Link>
            ) : null}
          </Card>
        ) : (
          <div className="flex flex-col gap-3">
            <ul className="flex flex-col gap-3">
              {page.items.map((item) => {
                const tone = dueTone(item.due_at, nowMs, zone);
                const mine = item.assigned_to.id === user.id;
                return (
                  <li key={item.id} data-followup={tone}>
                    <Card className="flex flex-col gap-3 px-4 py-4 lg:grid lg:grid-cols-[8rem_minmax(0,1fr)_14rem_auto] lg:items-center lg:gap-4">
                      <div className="flex flex-col gap-1">
                        <Link
                          href={requestHref(item.request_id)}
                          className="font-mono font-semibold text-navy-900 underline-offset-2 outline-none hover:underline focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-green-700"
                        >
                          {item.public_code}
                        </Link>
                        <span className="text-xs text-gray-500">
                          {t(`admin.queue.status.${item.request_status}`)}
                        </span>
                      </div>
                      <p className="break-words whitespace-pre-wrap">{item.note}</p>
                      <div className="flex flex-col gap-1 text-sm">
                        <span className="flex flex-wrap items-center gap-2">
                          <LocalTime iso={item.due_at} locale={locale} />
                          {tone === "later" ? null : (
                            <span
                              className={cn(
                                "inline-flex items-center rounded-pill px-3 py-0.5 text-xs font-semibold",
                                TONE[tone],
                              )}
                            >
                              {t(`admin.requests.ops.followups.${tone}`)}
                            </span>
                          )}
                        </span>
                        <span className="text-gray-500">
                          {mine
                            ? t("admin.requests.ops.followups.you")
                            : (item.assigned_to.name ?? t("admin.requests.ops.followups.noName"))}
                        </span>
                      </div>
                      {mine || isAdmin ? (
                        <FollowupDone
                          id={item.id}
                          action={completeFollowup.bind(null, item.request_id, item.id)}
                          label={t("admin.requests.ops.followups.done")}
                          text={text}
                        />
                      ) : (
                        <span />
                      )}
                    </Card>
                  </li>
                );
              })}
            </ul>
            {query.cursor || page.next_cursor ? (
              <div className="flex flex-wrap gap-3 pt-2">
                {query.cursor ? (
                  <Link href={followupsHref(first)} className={PILL_LINK}>
                    {t("admin.followups.first")}
                  </Link>
                ) : null}
                {page.next_cursor ? (
                  <Link
                    href={followupsHref({ ...first, cursor: page.next_cursor })}
                    className={PILL_LINK}
                  >
                    {t("admin.followups.older")}
                  </Link>
                ) : null}
              </div>
            ) : null}
          </div>
        )}
      </KeptDoneRefusal>
    </div>
  );
}
