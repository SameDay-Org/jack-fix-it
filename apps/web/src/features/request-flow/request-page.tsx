import { notFound } from "next/navigation";

import { contactEmail, requestFlowEnabled } from "@/features/landing/config";
import { LandingFooter } from "@/features/landing/landing-footer";
import { LandingHeader } from "@/features/landing/landing-header";
import { HtmlLang } from "@/features/site/html-lang";
import {
  LANDING_PATHS,
  PRIVACY_PATHS,
  REQUEST_PATHS,
  SHOWCASE_PATHS,
  TERMS_PATHS,
} from "@/features/site/routes";
import { FOCUS_ON_LIGHT } from "@/features/site/ui";
import type { Locale } from "@/i18n/config";
import { getT } from "@/i18n/server";
import { mintFormToken } from "@/lib/public-form/form-token";

import { checkZip, joinWaitlist, sendRequest } from "./actions";
import { utmFromSearch } from "./attribution";
import { requestFlowSecrets, storeLinks } from "./config";
import { requestFlowText } from "./copy";
import { RequestFlow } from "./request-flow";
import { loadRequestCategories, phoneCountryCode, type RequestCategory } from "./server";

/** Where "Skip to content" lands. */
const MAIN_ID = "content";

/**
 * The query /request may carry: the service picked beforehand (`service`, a slug) and the
 * campaign's `utm_*` keys (attribution.ts).
 */
export type RequestSearch = Record<string, string | string[] | undefined>;

/** The service a link picked (`?service=<slug>`), when it is one of the active ones. */
export function preselectedCategoryId(
  categories: readonly RequestCategory[] | null,
  search: RequestSearch,
): string | null {
  const slug = typeof search.service === "string" ? search.service : null;
  return categories?.find((category) => category.slug === slug)?.id ?? null;
}

/**
 * The web request flow (#86), in one language: no account needed. Off (a 404) unless
 * REQUEST_FLOW_ENABLED: nothing that does not work is shown as if it worked. The page is built
 * for each visitor and never stored (next.config.ts), and it is not indexed (metadata.ts).
 */
export async function RequestPage({ locale, search }: { locale: Locale; search: RequestSearch }) {
  if (!requestFlowEnabled()) notFound();
  // Both secrets or no form (config.ts): one that could not be sent is never shown.
  const { formSecret } = requestFlowSecrets();
  const t = await getT(locale);
  const categories = await loadRequestCategories(locale);

  return (
    <div lang={locale}>
      <HtmlLang locale={locale} />
      <a
        href={`#${MAIN_ID}`}
        className={`sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-pill focus:bg-white focus:px-5 focus:py-3 focus:font-bold focus:text-navy-900 focus:shadow-xl ${FOCUS_ON_LIGHT}`}
      >
        {t("landing.skipToContent")}
      </a>
      <LandingHeader t={t} locale={locale} page="request" />
      <main id={MAIN_ID} className="bg-gray-50 py-10 sm:py-16">
        <div className="mx-auto w-full max-w-2xl px-4 sm:px-8">
          <h1 className="text-[clamp(2rem,3vw+1rem,2.75rem)] leading-tight font-extrabold tracking-tight text-balance text-navy-900">
            {t("request.title")}
          </h1>
          <p className="mt-3 text-lg text-gray-500">{t("request.intro")}</p>
          <div className="mt-8 rounded-xl bg-white p-5 shadow-lg shadow-navy-900/5 sm:p-8">
            <noscript>
              <p className="mb-6 font-semibold text-navy-900">{t("request.noscript")}</p>
            </noscript>
            <RequestFlow
              locale={locale}
              text={requestFlowText(t)}
              categories={categories}
              initialCategoryId={preselectedCategoryId(categories, search)}
              countryCode={phoneCountryCode()}
              formToken={mintFormToken(formSecret, "request")}
              utm={utmFromSearch(search)}
              storeLinks={storeLinks()}
              appHref={SHOWCASE_PATHS[locale]}
              homeHref={LANDING_PATHS[locale]}
              termsHref={TERMS_PATHS[locale]}
              privacyHref={PRIVACY_PATHS[locale]}
              checkZip={checkZip}
              joinWaitlist={joinWaitlist}
              sendRequest={sendRequest}
            />
          </div>
        </div>
      </main>
      <LandingFooter
        t={t}
        locale={locale}
        contact={contactEmail()}
        year={new Date().getFullYear()}
        paths={REQUEST_PATHS}
      />
    </div>
  );
}
