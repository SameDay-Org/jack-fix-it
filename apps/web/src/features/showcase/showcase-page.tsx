import type { Locale } from "@/i18n/config";
import { getT } from "@/i18n/server";
import { cn } from "@/lib/utils";

import { ComingSoon, Faq, FinalCall } from "./closing";
import { ForPros, HowItWorks } from "./features";
import { Hero } from "./hero";
import { HtmlLang } from "@/features/site/html-lang";
import { SiteFooter } from "./site-footer";
import { SiteHeader } from "./site-header";
import { FOCUS_ON_LIGHT } from "@/features/site/ui";

/** Where "Skip to content" lands. */
const MAIN_ID = "content";

/**
 * The product showcase page (#403) in one language: what the Jack Fix It app is and how a job
 * goes in it, told with real screens of the app. Every section is rendered on the server and
 * reads without JavaScript. It claims only what the app does today (root AGENTS.md: real
 * features, legal copy): no download button, no reviews or numbers, no fees, no promise the
 * legal texts have not approved.
 */
export async function ShowcasePage({ locale }: { locale: Locale }) {
  const t = await getT(locale);

  return (
    <div lang={locale}>
      <HtmlLang locale={locale} />
      <a
        href={`#${MAIN_ID}`}
        className={cn(
          "sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-pill focus:bg-white focus:px-5 focus:py-3 focus:font-bold focus:text-navy-900 focus:shadow-xl",
          FOCUS_ON_LIGHT,
        )}
      >
        {t("showcase.skipToContent")}
      </a>
      <SiteHeader t={t} locale={locale} />
      <main id={MAIN_ID}>
        <Hero t={t} />
        <HowItWorks t={t} />
        <ForPros t={t} />
        <ComingSoon t={t} />
        <Faq t={t} />
        <FinalCall t={t} />
      </main>
      <SiteFooter t={t} locale={locale} year={new Date().getFullYear()} />
    </div>
  );
}
