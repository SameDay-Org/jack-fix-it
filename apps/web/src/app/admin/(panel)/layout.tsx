import { House, LogOut } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toLocale } from "@/i18n/locale";
import { getT } from "@/i18n/server";
import { requireStaff } from "@/lib/session";

import { logout } from "../logout/actions";

/**
 * The panel shell: every page under it requires a staff session (requireStaff, checked against
 * the API on each request). The sidebar lists only pages that exist.
 */
export default async function PanelLayout({ children }: { children: ReactNode }) {
  const user = await requireStaff();
  const locale = toLocale(user.locale);
  const t = await getT(locale);
  const role = user.role === "admin" ? t("admin.roles.admin") : t("admin.roles.agent");

  return (
    <div lang={locale} className="min-h-dvh bg-gray-50 md:flex">
      <aside className="flex items-center gap-4 bg-navy-900 px-4 py-3 text-white md:min-h-dvh md:w-64 md:shrink-0 md:flex-col md:items-stretch md:gap-8 md:px-5 md:py-8">
        <p className="text-lg font-bold">
          {t("brand.name")} <span className="text-green-500">{t("admin.title")}</span>
        </p>
        <nav aria-label={t("admin.nav.label")} className="flex gap-2 md:flex-col">
          <Link
            href="/admin"
            aria-current="page"
            className="inline-flex items-center gap-2 rounded-pill bg-navy-700 px-4 py-2 text-sm font-semibold text-white"
          >
            <House aria-hidden className="size-4" />
            {t("admin.nav.home")}
          </Link>
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
        <main className="flex-1 px-4 py-6 md:px-8 md:py-8">{children}</main>
      </div>
    </div>
  );
}
