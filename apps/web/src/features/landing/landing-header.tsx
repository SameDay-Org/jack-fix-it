import type { TFunction } from "i18next";
import Link from "next/link";

import { LanguageToggle } from "@/features/site/language-toggle";
import { type MenuLink, MobileMenu } from "@/features/site/mobile-menu";
import { FOR_PROS_PATHS, LANDING_PATHS, SHOWCASE_PATHS } from "@/features/site/routes";
import { CONTAINER, FOCUS_ON_NAVY } from "@/features/site/ui";
import { Wordmark } from "@/features/site/wordmark";
import type { Locale } from "@/i18n/config";
import { cn } from "@/lib/utils";

import { LANDING_ANCHORS } from "./config";

const NAV_LINK = cn(
  "inline-flex h-10 items-center rounded-pill px-4 text-sm font-semibold hover:bg-navy-700",
  FOCUS_ON_NAVY,
);

/** The pages that share this header: the landing (#85) and the page for professionals (#88). */
export type SitePage = "landing" | "forPros";

/** The page's own sections, in its header. */
const SECTIONS = {
  landing: [
    [LANDING_ANCHORS.services, "landing.nav.services"],
    [LANDING_ANCHORS.how, "landing.nav.how"],
  ],
  forPros: [
    ["how", "forPros.nav.how"],
    ["faq", "forPros.nav.faq"],
  ],
} as const satisfies Record<SitePage, readonly (readonly [string, string])[]>;

/**
 * The public pages' header, kept in view while scrolling: the brand (the landing's top), the
 * page's own sections, the page for professionals (from the landing), the language switch and
 * the way to the app. No "Sign in": there is no web sign-in for customers or pros. Below `lg`
 * the links fold into a menu.
 */
export function LandingHeader({
  t,
  locale,
  page = "landing",
}: {
  t: TFunction;
  locale: Locale;
  page?: SitePage;
}) {
  const sections: MenuLink[] = SECTIONS[page].map(([anchor, key]) => ({
    href: `#${anchor}`,
    label: t(key),
  }));
  if (page === "landing") {
    sections.push({ href: FOR_PROS_PATHS[locale], label: t("landing.nav.forPros") });
  }
  const app: MenuLink = { href: SHOWCASE_PATHS[locale], label: t("landing.nav.getApp") };
  const home = page === "landing" ? `#${LANDING_ANCHORS.top}` : LANDING_PATHS[locale];

  return (
    <header className="sticky top-0 z-40 bg-navy-900/95 text-white backdrop-blur-md">
      <div className={cn(CONTAINER, "flex h-16 items-center gap-2 sm:gap-4")}>
        <a
          href={home}
          aria-label={t("landing.homeLabel")}
          className={cn(
            "mr-auto rounded-pill text-xl font-extrabold tracking-tight whitespace-nowrap",
            FOCUS_ON_NAVY,
          )}
        >
          <Wordmark name={t("brand.name")} />
        </a>
        <nav aria-label={t("landing.nav.label")} className="hidden items-center gap-1 lg:flex">
          {sections.map((link) => (
            <a key={link.href} href={link.href} className={NAV_LINK}>
              {link.label}
            </a>
          ))}
        </nav>
        <LanguageToggle
          t={t}
          locale={locale}
          paths={page === "landing" ? LANDING_PATHS : FOR_PROS_PATHS}
        />
        <Link
          href={app.href}
          prefetch={false}
          className={cn(
            "hidden h-10 items-center rounded-pill bg-green-500 px-5 text-sm font-bold text-navy-900 transition-colors hover:bg-green-700 hover:text-white lg:inline-flex",
            FOCUS_ON_NAVY,
          )}
        >
          {app.label}
        </Link>
        <MobileMenu
          label={t("landing.nav.menu")}
          navLabel={t("landing.nav.label")}
          links={[...sections, app]}
        />
      </div>
    </header>
  );
}
