import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { Card, CardDescription } from "@/components/ui/card";
import { defaultLocale } from "@/i18n/config";
import { getT } from "@/i18n/server";
import { RETURN_PARAM, safeReturnPath, withReturn } from "@/lib/return-path";
import {
  BUSY_AUTO_RETRY_MAX_SECONDS,
  LOGIN_PATH,
  PANEL_PATH,
  REFRESH_PATH,
  RETRIED_PARAM,
  SESSION_COOKIE,
  WAIT_PARAM,
} from "@/lib/session";

import { RetryOnce } from "./retry-once";

type SearchParams = Record<string, string | string[] | undefined>;

/** The wait before the one retry: whole seconds, 1 to BUSY_AUTO_RETRY_MAX_SECONDS, else none. */
function waitOf(raw: SearchParams[string]): number | null {
  if (typeof raw !== "string" || !/^\d{1,3}$/.test(raw)) return null;
  const seconds = Number(raw);
  return seconds >= 1 && seconds <= BUSY_AUTO_RETRY_MAX_SECONDS ? seconds : null;
}

/**
 * The API could not renew the session just now (#530: a 429, a 503, no answer). The cookies
 * were kept, so the staff member is told they are still signed in, with a way back to the page
 * they asked for (`?next=`, validated again). With a short wait (`?wait=`) the page retries the
 * refresh by itself, once. It asks nothing of the API, and a browser without a session goes to
 * the login. Before `/me` answers the language is unknown: the panel's default, as the login.
 */
export default async function BusyPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const query = await searchParams;
  const requested = query[RETURN_PARAM];
  const back = safeReturnPath(typeof requested === "string" ? requested : null);
  if (!(await cookies()).get(SESSION_COOKIE)) redirect(withReturn(LOGIN_PATH, back));
  const wait = waitOf(query[WAIT_PARAM]);
  const retry = new URLSearchParams();
  if (back !== null) retry.set(RETURN_PARAM, back);
  retry.set(RETRIED_PARAM, "1");
  const t = await getT(defaultLocale);

  return (
    <main className="flex min-h-dvh items-center justify-center bg-navy-900 px-4 py-10">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <p className="text-center text-2xl font-bold text-white">
          {t("brand.name")} <span className="text-green-500">{t("admin.title")}</span>
        </p>
        <Card className="flex flex-col gap-6 rounded-xl p-8">
          <div className="flex flex-col gap-1">
            <h1 className="text-xl font-bold">{t("admin.busy.title")}</h1>
            <CardDescription>{t("admin.busy.body")}</CardDescription>
          </div>
          <a
            href={back ?? PANEL_PATH}
            className="inline-flex h-11 items-center justify-center rounded-pill bg-green-500 px-6 text-sm font-semibold text-navy-900 outline-none hover:bg-green-700 hover:text-white focus-visible:ring-2 focus-visible:ring-green-700 focus-visible:ring-offset-2"
          >
            {t("admin.busy.retry")}
          </a>
        </Card>
      </div>
      {wait === null ? null : <RetryOnce href={`${REFRESH_PATH}?${retry}`} seconds={wait} />}
    </main>
  );
}
