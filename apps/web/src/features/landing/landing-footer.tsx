import type { TFunction } from "i18next";
import Link from "next/link";

import { LanguageToggle } from "@/features/site/language-toggle";
import { FOR_PROS_PATHS, PRIVACY_PATHS, TERMS_PATHS } from "@/features/site/routes";
import { CONTAINER, FOCUS_ON_NAVY } from "@/features/site/ui";
import { Wordmark } from "@/features/site/wordmark";
import type { Locale } from "@/i18n/config";
import { cn } from "@/lib/utils";

const FOOTER_LINK = cn(
  "inline-flex min-h-11 items-center rounded-pill text-base font-semibold underline-offset-4 hover:underline",
  FOCUS_ON_NAVY,
);

/**
 * The footer: the brand and its line, the page for professionals, the legal pages (placeholders
 * until the texts are approved), Contact when CONTACT_EMAIL is set (`contact`; no link
 * otherwise), the language switch (to this page's twin: `paths`) and the copyright. No links to
 * pages that do not exist yet (service areas, help). `year` is the year the page was built.
 */
export function LandingFooter({
  t,
  locale,
  contact,
  year,
  paths,
}: {
  t: TFunction;
  locale: Locale;
  contact: string | null;
  year: number;
  paths: Record<Locale, string>;
}) {
  return (
    <footer className="bg-navy-900 text-white">
      <div className={cn(CONTAINER, "flex flex-col gap-10 py-14")}>
        <div className="flex flex-col gap-10 sm:flex-row sm:justify-between">
          <div className="flex max-w-sm flex-col gap-3">
            <p className="text-2xl font-extrabold tracking-tight">
              <Wordmark name={t("brand.name")} />
            </p>
            <p className="text-base">{t("brand.tagline")}</p>
          </div>
          <nav aria-label={t("landing.footer.label")}>
            <ul className="flex flex-col">
              <li>
                <Link href={FOR_PROS_PATHS[locale]} prefetch={false} className={FOOTER_LINK}>
                  {t("landing.footer.forPros")}
                </Link>
              </li>
              <li>
                <Link href={TERMS_PATHS[locale]} prefetch={false} className={FOOTER_LINK}>
                  {t("landing.footer.terms")}
                </Link>
              </li>
              <li>
                <Link href={PRIVACY_PATHS[locale]} prefetch={false} className={FOOTER_LINK}>
                  {t("landing.footer.privacy")}
                </Link>
              </li>
              {contact ? (
                <li>
                  <a href={`mailto:${contact}`} className={FOOTER_LINK}>
                    {t("landing.footer.contact")}
                  </a>
                </li>
              ) : null}
            </ul>
          </nav>
        </div>
        <div className="flex flex-col gap-6 border-t border-navy-700 pt-8 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm">{t("landing.footer.rights", { year })}</p>
          <LanguageToggle t={t} locale={locale} paths={paths} className="self-start" />
        </div>
      </div>
    </footer>
  );
}
