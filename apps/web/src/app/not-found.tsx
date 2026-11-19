import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";

import { SITE_PAGE } from "@/features/site/font";
import { HtmlLang } from "@/features/site/html-lang";
import { MascotImage } from "@/features/site/mascot-image";
import { LANDING_PATHS, localeOfPath } from "@/features/site/routes";
import { defaultLocale, type Locale } from "@/i18n/config";
import { getT } from "@/i18n/server";
import { PATH_HEADER } from "@/lib/return-path";

/** The panel's home (lib/session.ts PANEL_PATH). */
const PANEL_HOME = "/admin";

/** Which 404 this is: the panel's (its default language) or the site's (the path's language). */
async function context(): Promise<{ panel: boolean; locale: Locale }> {
  const path = ((await headers()).get(PATH_HEADER) ?? "/").split(/[?#]/)[0];
  const panel = path === PANEL_HOME || path.startsWith(`${PANEL_HOME}/`);
  return { panel, locale: panel ? defaultLocale : localeOfPath(path) };
}

export async function generateMetadata(): Promise<Metadata> {
  const { panel, locale } = await context();
  const t = await getT(locale);
  return { title: t(panel ? "admin.notFound.metaTitle" : "site.notFound.metaTitle") };
}

const ACTION =
  "inline-flex h-12 items-center justify-center rounded-pill bg-green-500 px-7 text-base font-bold text-navy-900 transition-colors outline-none hover:bg-green-700 hover:text-white focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2";

/**
 * Every address the site does not have, and every `notFound()` (#462): calm words in the
 * page's language (Spanish under `/es`), the way home, the site's look; under `/admin`, the
 * panel's look and the way back to the panel. The path comes from the proxy (src/proxy.ts):
 * a 404 has no page to ask. Next answers 404 and adds `noindex`.
 */
export default async function NotFound() {
  const { panel, locale } = await context();
  const t = await getT(locale);

  if (panel) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-navy-900 px-4 py-10">
        <div className="flex w-full max-w-md flex-col items-start gap-4 rounded-xl bg-white p-8">
          <h1 className="text-xl font-bold text-balance">{t("admin.notFound.title")}</h1>
          <p className="text-gray-500">{t("admin.notFound.body")}</p>
          <Link href={PANEL_HOME} prefetch={false} className={ACTION}>
            {t("admin.notFound.home")}
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main
      lang={locale}
      className={`${SITE_PAGE} flex min-h-dvh flex-col items-center justify-center gap-6 bg-navy-900 px-5 py-16 text-center text-white`}
    >
      <HtmlLang locale={locale} />
      <MascotImage pose="peek" size={112} className="rounded-full bg-gray-50 p-3" />
      <h1 className="max-w-xl text-[clamp(2rem,3vw+1rem,3rem)] leading-tight font-extrabold tracking-tight text-balance">
        {t("site.notFound.title")}
      </h1>
      <p className="max-w-md text-lg leading-relaxed">{t("site.notFound.body")}</p>
      <Link href={LANDING_PATHS[locale]} prefetch={false} className={ACTION}>
        {t("site.notFound.home")}
      </Link>
    </main>
  );
}
