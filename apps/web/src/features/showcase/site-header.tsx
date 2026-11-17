import type { TFunction } from "i18next";

import type { Locale } from "@/i18n/config";
import { cn } from "@/lib/utils";

import { LanguageToggle } from "./language-toggle";
import { type MenuLink, MobileMenu } from "./mobile-menu";
import { ANCHORS, SHOWCASE_PATHS } from "./routes";
import { CONTAINER, FOCUS_ON_NAVY } from "./ui";
import { Wordmark } from "./wordmark";

/**
 * The page's header, kept in view while scrolling: the brand (back to the top), the links to
 * the sections, the language switch and the way to the "coming soon" notice. Below `lg` the
 * section links fold into a menu.
 */
export function SiteHeader({ t, locale }: { t: TFunction; locale: Locale }) {
  const sections: MenuLink[] = [
    { href: `#${ANCHORS.how}`, label: t("showcase.nav.how") },
    { href: `#${ANCHORS.pros}`, label: t("showcase.nav.pros") },
    { href: `#${ANCHORS.faq}`, label: t("showcase.nav.faq") },
  ];
  const soon: MenuLink = { href: `#${ANCHORS.soon}`, label: t("showcase.nav.soon") };

  return (
    <header className="sticky top-0 z-40 bg-navy-900/95 text-white backdrop-blur-md">
      <div className={cn(CONTAINER, "flex h-16 items-center gap-2 sm:gap-4")}>
        <a
          href={`#${ANCHORS.top}`}
          aria-label={t("showcase.homeLabel")}
          className={cn(
            "mr-auto rounded-pill text-xl font-extrabold tracking-tight whitespace-nowrap",
            FOCUS_ON_NAVY,
          )}
        >
          <Wordmark name={t("brand.name")} />
        </a>
        <nav aria-label={t("showcase.nav.label")} className="hidden items-center gap-1 lg:flex">
          {sections.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className={cn(
                "inline-flex h-10 items-center rounded-pill px-4 text-sm font-semibold hover:bg-navy-700",
                FOCUS_ON_NAVY,
              )}
            >
              {link.label}
            </a>
          ))}
        </nav>
        <LanguageToggle t={t} locale={locale} paths={SHOWCASE_PATHS} />
        <a
          href={soon.href}
          className={cn(
            "hidden h-10 items-center rounded-pill bg-green-500 px-5 text-sm font-bold text-navy-900 transition-colors hover:bg-green-700 hover:text-white lg:inline-flex",
            FOCUS_ON_NAVY,
          )}
        >
          {soon.label}
        </a>
        <MobileMenu
          label={t("showcase.nav.menu")}
          navLabel={t("showcase.nav.label")}
          links={[...sections, soon]}
        />
      </div>
    </header>
  );
}
