import {
  BadgeCheck,
  CalendarClock,
  ChartLine,
  House,
  LifeBuoy,
  ListTodo,
  LogOut,
  Scale,
} from "lucide-react";
import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ErrorCopyProvider } from "@/features/site/error-copy";
import { panelErrorCopy } from "@/features/site/error-copy-server";
import { toLocale } from "@/i18n/locale";
import { getT } from "@/i18n/server";
import { apiGet } from "@/lib/api";
import { requireStaff, staffAuth } from "@/lib/session";

import { logout } from "../logout/actions";
import { DISPUTES_PATH } from "./disputes/disputes";
import { FOLLOWUPS_PATH } from "./followups/followups";
import { KPIS_PATH } from "./kpis/range";
import { NavLink } from "./nav-link";
import { PROS_PATH } from "./pros/pros";
import { QUEUE_PATH } from "./queue/queue";
import { SUPPORT_PATH } from "./support/tickets";

/** The reader's open follow-ups due by tonight, for the nav badge; none when the API cannot say. */
async function dueToday(): Promise<number> {
  try {
    return (await apiGet("/v1/admin/followups/summary", await staffAuth())).due_today;
  } catch {
    return 0;
  }
}

/**
 * The panel shell: every page under it requires a staff session (requireStaff, checked against
 * the API on each request). The sidebar lists only pages that exist.
 */
export default async function PanelLayout({ children }: { children: ReactNode }) {
  const user = await requireStaff();
  const locale = toLocale(user.locale);
  const t = await getT(locale);
  const role = user.role === "admin" ? t("admin.roles.admin") : t("admin.roles.agent");
  const due = await dueToday();

  return (
    <div lang={locale} className="min-h-dvh bg-gray-50 md:flex">
      <aside className="flex flex-wrap items-center gap-x-4 gap-y-2 bg-navy-900 px-4 py-3 text-white md:min-h-dvh md:w-64 md:shrink-0 md:flex-col md:flex-nowrap md:items-stretch md:gap-8 md:px-5 md:py-8">
        <p className="text-lg font-bold whitespace-nowrap md:whitespace-normal">
          {t("brand.name")} <span className="text-green-500">{t("admin.title")}</span>
        </p>
        {/* Wraps on a phone: the links are wider than a 320 px screen in English and Spanish. */}
        <nav
          aria-label={t("admin.nav.label")}
          className="flex flex-wrap gap-2 md:flex-col md:flex-nowrap"
        >
          <NavLink href="/admin" exact>
            <House aria-hidden className="size-4" />
            {t("admin.nav.home")}
          </NavLink>
          <NavLink href={QUEUE_PATH}>
            <ListTodo aria-hidden className="size-4" />
            {t("admin.nav.queue")}
          </NavLink>
          <NavLink href={FOLLOWUPS_PATH}>
            <CalendarClock aria-hidden className="size-4" />
            {t("admin.nav.followups")}
            {due > 0 ? (
              <>
                <span
                  aria-hidden
                  data-due={due}
                  className="ml-auto inline-flex min-w-6 items-center justify-center rounded-pill bg-warning px-2 text-xs font-bold text-navy-900"
                >
                  {due}
                </span>
                <span className="sr-only">{t("admin.nav.followupsDue", { count: due })}</span>
              </>
            ) : null}
          </NavLink>
          <NavLink href={PROS_PATH}>
            <BadgeCheck aria-hidden className="size-4" />
            {t("admin.nav.pros")}
          </NavLink>
          <NavLink href={SUPPORT_PATH}>
            <LifeBuoy aria-hidden className="size-4" />
            {t("admin.nav.support")}
          </NavLink>
          <NavLink href={DISPUTES_PATH}>
            <Scale aria-hidden className="size-4" />
            {t("admin.nav.disputes")}
          </NavLink>
          <NavLink href={KPIS_PATH}>
            <ChartLine aria-hidden className="size-4" />
            {t("admin.nav.kpis")}
          </NavLink>
        </nav>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center justify-between gap-3 bg-white px-4 py-3 shadow-[0_4px_16px_rgb(1_23_46/0.06)] md:px-8">
          <div className="flex min-w-0 items-center gap-3">
            <span className="truncate text-sm font-semibold">{user.email}</span>
            <Badge>{role}</Badge>
          </div>
          <form action={logout}>
            <Button type="submit" variant="secondary" size="sm">
              <LogOut aria-hidden />
              {t("admin.logout")}
            </Button>
          </form>
        </header>
        <main className="flex-1 px-4 py-6 md:px-8 md:py-8">
          {/* A page that fails keeps the frame and speaks the staff member's language (#462). */}
          <ErrorCopyProvider copy={panelErrorCopy(t)}>{children}</ErrorCopyProvider>
        </main>
      </div>
    </div>
  );
}
