import type { TFunction } from "i18next";
import Link from "next/link";

import type { Locale } from "@/i18n/config";
import { cn } from "@/lib/utils";

import { LanguageToggle } from "@/features/site/language-toggle";
import { PRIVACY_PATHS, TERMS_PATHS } from "@/features/site/routes";

import { ANCHORS, SHOWCASE_PATHS } from "./routes";
import { CONTAINER, FOCUS_ON_NAVY } from "@/features/site/ui";
import { Wordmark } from "@/features/site/wordmark";

const FOOTER_LINK = cn(
  "inline-flex min-h-11 items-center rounded-pill text-base font-semibold underline-offset-4 hover:underline",
  FOCUS_ON_NAVY,
);

/**
 * The footer: the brand and its line, the sections again, the legal pages (placeholders until
 * the texts are approved), the language switch, and the note that the screens above show
 * sample data. `year` is the year the page was built.
 */
export function SiteFooter({ t, locale, year }: { t: TFunction; locale: Locale; year: number }) {
  return (
    <footer className="bg-navy-900 text-white">
      <div className={cn(CONTAINER, "flex flex-col gap-10 py-14")}>
        <div className="flex flex-col gap-10 lg:flex-row lg:justify-between">
          <div className="flex max-w-sm flex-col gap-3">
            <p className="text-2xl font-extrabold tracking-tight">
              <Wordmark name={t("brand.name")} />
            </p>
            <p className="text-base">{t("brand.tagline")}</p>
          </div>
          <div className="flex flex-wrap gap-x-16 gap-y-8">
            <nav aria-label={t("showcase.nav.label")}>
              <ul className="flex flex-col">
                <li>
                  <a href={`#${ANCHORS.how}`} className={FOOTER_LINK}>
                    {t("showcase.nav.how")}
                  </a>
                </li>
                <li>
                  <a href={`#${ANCHORS.pros}`} className={FOOTER_LINK}>
                    {t("showcase.nav.pros")}
                  </a>
                </li>
                <li>
                  <a href={`#${ANCHORS.faq}`} className={FOOTER_LINK}>
                    {t("showcase.nav.faq")}
                  </a>
                </li>
              </ul>
            </nav>
            <nav aria-label={t("showcase.footer.legalLabel")}>
              <ul className="flex flex-col">
                <li>
                  <Link href={TERMS_PATHS[locale]} prefetch={false} className={FOOTER_LINK}>
                    {t("showcase.footer.terms")}
                  </Link>
                </li>
                <li>
                  <Link href={PRIVACY_PATHS[locale]} prefetch={false} className={FOOTER_LINK}>
                    {t("showcase.footer.privacy")}
                  </Link>
                </li>
              </ul>
            </nav>
          </div>
        </div>
        <div className="flex flex-col gap-6 border-t border-navy-700 pt-8 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-col gap-1 text-sm">
            <p>{t("showcase.footer.rights", { year })}</p>
            <p>{t("showcase.footer.sampleData")}</p>
          </div>
          <LanguageToggle t={t} locale={locale} paths={SHOWCASE_PATHS} />
        </div>
      </div>
    </footer>
  );
}
